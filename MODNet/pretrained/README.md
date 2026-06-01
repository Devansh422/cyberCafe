## MODNet - Pre-Trained Models
This folder is used to save the official pre-trained models of MODNet. You can download them from this [link](https://drive.google.com/drive/folders/1umYmlCulvIFNaqPjwod1SayFmSRHziyR?usp=sharing).

### ONNX model for Ratan's passport pipeline
Ratan runs MODNet **natively in Node** (via `onnxruntime-node`) — no Python needed.
It expects an **ONNX** model. Place it at one of these paths (checked in order):

```
MODNet/pretrained/modnet.onnx                              ← preferred
MODNet/pretrained/modnet_photographic_portrait_matting.onnx
MODNet/onnx/modnet.onnx
```

…or point the backend at any location with the `MODNET_ONNX` env var.

How to get the `.onnx`:
- Download a pre-exported MODNet portrait-matting ONNX model, **or**
- Export it from the official `.ckpt` with [`MODNet/onnx/export_onnx.py`](../onnx/export_onnx.py)
  (`python export_onnx.py --ckpt-path=modnet_photographic_portrait_matting.ckpt --output-path=modnet.onnx`).

Until a model is present the Passport page still tiles photos onto the 4"×6" sheet,
but **backgrounds are not removed** (the page shows a "MODNet offline" warning).
Check status anytime at `GET /api/passport/status`.