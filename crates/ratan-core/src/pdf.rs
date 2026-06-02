//! Low-level PDF helpers built on `lopdf` — replaces the pieces of `pdf-lib`
//! the backend used: embedding a raster image as a full-page PDF (image→PDF and
//! the passport sheet), counting pages (copyPdf), and merging PDFs (batch merge).

use lopdf::content::{Content, Operation};
use lopdf::{dictionary, Document, Object, ObjectId, Stream};

/// A stroked cut-guide rectangle in PDF points (origin bottom-left).
pub struct Guide {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

/// Build a one-page PDF (`page_w`×`page_h` points) with the RGB image
/// (`px_w`×`px_h`, 3 bytes/pixel) drawn to fill the page, plus optional light-gray
/// guide rectangles. The raw pixels are Flate-compressed.
pub fn image_page(
    rgb: &[u8],
    px_w: u32,
    px_h: u32,
    page_w: f64,
    page_h: f64,
    guides: &[Guide],
) -> anyhow::Result<Vec<u8>> {
    let mut doc = Document::with_version("1.5");
    let img_dict = dictionary! {
        "Type" => "XObject",
        "Subtype" => "Image",
        "Width" => px_w as i64,
        "Height" => px_h as i64,
        "ColorSpace" => "DeviceRGB",
        "BitsPerComponent" => 8i64,
    };
    let mut img_stream = Stream::new(img_dict, rgb.to_vec());
    let _ = img_stream.compress();
    let img_id = doc.add_object(img_stream);
    finish_image_page(doc, img_id, page_w, page_h, guides)
}

/// Like [`image_page`] but embeds an already-encoded **JPEG** via `DCTDecode`.
/// Photos compress an order of magnitude smaller than raw-RGB+Flate, so this is
/// what the collage pipeline uses to avoid huge output files.
pub fn jpeg_page(
    jpeg: &[u8],
    px_w: u32,
    px_h: u32,
    page_w: f64,
    page_h: f64,
    guides: &[Guide],
) -> anyhow::Result<Vec<u8>> {
    let mut doc = Document::with_version("1.5");
    let img_dict = dictionary! {
        "Type" => "XObject",
        "Subtype" => "Image",
        "Width" => px_w as i64,
        "Height" => px_h as i64,
        "ColorSpace" => "DeviceRGB",
        "BitsPerComponent" => 8i64,
        "Filter" => "DCTDecode",
    };
    // The JPEG bytes are the stream as-is — do NOT re-compress.
    let img_stream = Stream::new(img_dict, jpeg.to_vec());
    let img_id = doc.add_object(img_stream);
    finish_image_page(doc, img_id, page_w, page_h, guides)
}

/// Shared page assembly: draw the image XObject `img_id` to fill the page, add
/// optional cut-guides, and serialize the one-page document.
fn finish_image_page(
    mut doc: Document,
    img_id: ObjectId,
    page_w: f64,
    page_h: f64,
    guides: &[Guide],
) -> anyhow::Result<Vec<u8>> {
    let pages_id = doc.new_object_id();

    let mut ops = vec![
        Operation::new("q", vec![]),
        // Map the image's unit square onto the whole page.
        Operation::new("cm", vec![page_w.into(), 0.0.into(), 0.0.into(), page_h.into(), 0.0.into(), 0.0.into()]),
        Operation::new("Do", vec![Object::Name(b"Im0".to_vec())]),
        Operation::new("Q", vec![]),
    ];
    if !guides.is_empty() {
        ops.push(Operation::new("q", vec![]));
        ops.push(Operation::new("RG", vec![0.78.into(), 0.78.into(), 0.78.into()]));
        ops.push(Operation::new("w", vec![0.5.into()]));
        for g in guides {
            ops.push(Operation::new("re", vec![g.x.into(), g.y.into(), g.w.into(), g.h.into()]));
        }
        ops.push(Operation::new("S", vec![]));
        ops.push(Operation::new("Q", vec![]));
    }
    let content = Content { operations: ops };
    let content_id = doc.add_object(Stream::new(dictionary! {}, content.encode()?));

    let resources_id = doc.add_object(dictionary! {
        "XObject" => dictionary! { "Im0" => img_id },
    });

    let page_id = doc.add_object(dictionary! {
        "Type" => "Page",
        "Parent" => pages_id,
        "MediaBox" => vec![0.0.into(), 0.0.into(), page_w.into(), page_h.into()],
        "Contents" => content_id,
        "Resources" => resources_id,
    });

    let pages = dictionary! {
        "Type" => "Pages",
        "Kids" => vec![page_id.into()],
        "Count" => 1i64,
    };
    doc.objects.insert(pages_id, Object::Dictionary(pages));

    let catalog_id = doc.add_object(dictionary! {
        "Type" => "Catalog",
        "Pages" => pages_id,
    });
    doc.trailer.set("Root", catalog_id);

    let mut buf = Vec::new();
    doc.save_to(&mut buf)?;
    Ok(buf)
}

/// Number of pages in a PDF (defaults to 1 on parse failure, like the JS).
pub fn page_count(bytes: &[u8]) -> usize {
    Document::load_mem(bytes).map(|d| d.get_pages().len()).unwrap_or(1)
}

/// Merge several PDFs into one, concatenating all pages in order.
pub fn merge_pdfs(buffers: Vec<Vec<u8>>) -> anyhow::Result<Vec<u8>> {
    use std::collections::BTreeMap;

    let mut max_id = 1u32;
    let mut documents_pages: BTreeMap<ObjectId, Object> = BTreeMap::new();
    let mut documents_objects: BTreeMap<ObjectId, Object> = BTreeMap::new();
    let mut document = Document::with_version("1.5");

    for buf in buffers {
        let mut doc = Document::load_mem(&buf)?;
        doc.renumber_objects_with(max_id);
        max_id = doc.max_id + 1;
        documents_pages.extend(
            doc.get_pages()
                .into_values()
                .filter_map(|id| doc.get_object(id).ok().map(|o| (id, o.to_owned()))),
        );
        documents_objects.extend(doc.objects);
    }

    let mut catalog_id: Option<ObjectId> = None;
    let mut pages_id: Option<ObjectId> = None;

    for (id, object) in &documents_objects {
        match object.type_name().unwrap_or("") {
            "Catalog" => catalog_id = Some(*id),
            "Pages" => {
                if pages_id.is_none() {
                    pages_id = Some(*id);
                }
            }
            _ => {}
        }
    }

    let catalog_id = catalog_id.ok_or_else(|| anyhow::anyhow!("merge: no Catalog found"))?;
    let pages_id = pages_id.ok_or_else(|| anyhow::anyhow!("merge: no Pages found"))?;

    // Re-parent every page to the single merged Pages node.
    for (id, object) in &documents_pages {
        if let Ok(d) = object.as_dict() {
            let mut d = d.clone();
            d.set("Parent", pages_id);
            document.objects.insert(*id, Object::Dictionary(d));
        }
    }

    // Copy over all non-structural objects (fonts, xobjects, content, …).
    for (id, object) in &documents_objects {
        match object.type_name().unwrap_or("") {
            "Catalog" | "Pages" | "Page" => {}
            _ => {
                document.objects.insert(*id, object.clone());
            }
        }
    }

    // Build the merged Pages node.
    let kids: Vec<Object> = documents_pages.keys().map(|id| Object::Reference(*id)).collect();
    let pages_dict = dictionary! {
        "Type" => "Pages",
        "Count" => documents_pages.len() as i64,
        "Kids" => kids,
    };
    document.objects.insert(pages_id, Object::Dictionary(pages_dict));

    // Catalog → merged Pages.
    let catalog_dict = dictionary! {
        "Type" => "Catalog",
        "Pages" => pages_id,
    };
    document.objects.insert(catalog_id, Object::Dictionary(catalog_dict));

    document.trailer.set("Root", catalog_id);
    document.max_id = max_id;
    document.renumber_objects();
    document.compress();

    let mut buf = Vec::new();
    document.save_to(&mut buf)?;
    Ok(buf)
}
