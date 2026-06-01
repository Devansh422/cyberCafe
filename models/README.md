# Models

ONNX models used by the passport pipeline (run in Node via `onnxruntime-node`).

## ultraface-RFB-320.onnx
Lightweight face detector (UltraFace, version-RFB-320, ~1.2 MB) used to locate
and centre the face before cropping a passport photo to 3:4.

- Source: ONNX Model Zoo —
  `validated/vision/body_analysis/ultraface/models/version-RFB-320.onnx`
- Input: `input` `[1,3,240,320]` (W=320, H=240), normalised `(x-127)/128`, RGB/NCHW.
- Outputs: `scores` `[1,N,2]` (bg, face) and `boxes` `[1,N,4]` (decoded, normalised corners).
- The backend looks for it here, then at `MODNet/pretrained/ultraface-RFB-320.onnx`,
  or wherever `FACE_ONNX` points.

If this file is missing the passport crop falls back to a centred frame
(`faceDetected:false`); see `GET /api/passport/status`.

The MODNet background-removal model lives at `MODNet/pretrained/modnet.onnx`
(see that folder's README).
