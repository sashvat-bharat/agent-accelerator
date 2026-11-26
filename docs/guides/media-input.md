# Media input

> Send images, audio, video and documents to a model.

```ts
import { Agent } from "agent-accelerator";

const agent = new Agent({
  model: "google/gemini-3.5-flash-lite",
  fileAccess: { roots: [process.cwd()] }, // local paths must stay inside these folders
});

const res = await agent.run([
  { type: "text", text: "What is in this picture, and what does the PDF say?" },
  { type: "image", image: "https://example.com/photo.png" },
  { type: "file", file: "./report.pdf", filename: "report.pdf" },
]);
console.log(res.text);
```

A prompt is a string, or a list of parts.

| Part | Key | Accepts |
|---|---|---|
| `text` | `text` | A string. |
| `image` | `image` | A URL, a local path, a data URL, base64, or bytes (`Uint8Array`). |
| `audio` | `audio` | The same. |
| `video` | `video` | The same. |
| `file` | `file` | The same, for documents such as PDF. Also takes `filename` and `mimeType`. |

- The MIME type is found from the file extension or from the first bytes of the data.
- A URL that the SDK has to download itself must point to a public host. `localhost`, `127.x`, `10.x`, `192.168.x`, `169.254.169.254` (cloud metadata), `.local` and `.internal` names, a name that DNS resolves to one of them, a name whose address cannot be looked up, and a redirect to one all throw `SecurityPolicyError`. For a file on your intranet, read it yourself and pass the bytes, a data URL or base64. A link that the provider fetches itself is sent as it is (see the notes per provider below). A browser is not checked.
- An input the model cannot take fails before the network with a one-line error. The catalog knows what each model accepts. Custom services reject video and files.
- A model without native file input fails fast on every provider except OpenRouter, which reads files for any model. Everywhere else, turn the document into text yourself before you call `run`. The SDK has no converter.
- Remote downloads re-check redirects and have a size cap.
- Images and videos can carry a `resolution`: `"low"`, `"medium"`, `"high"` or `"ultra_high"`. It trades detail for input tokens. Example: `{ type: "image", image: "./chart.png", resolution: "high" }`.

## What each provider accepts

### Google

- **Sent as a link (no download).** YouTube links, Files API links (`https://generativelanguage.googleapis.com/v1beta/files/...` or `/v1/files/...`), `gs://` objects, and public `https://` links of a type Google fetches: PDF, CSV, plain text, HTML, CSS, XML, RTF, JavaScript, JSON, PNG, JPEG, WebP, BMP images and common video formats. The limit is 15 MB per link.
- **Downloaded and inlined.** Everything else, including all audio links and `http://` links.
- **Inline types** are checked before the network.
  - Images: PNG, JPEG, WebP, HEIC, HEIF, GIF, BMP, TIFF.
  - Audio: WAV, MP3, AIFF, AAC, OGG, FLAC, MPEG, M4A, L16, OPUS, ALAW, MULAW, WebM.
  - Video: MP4, MPEG, MPG, MOV, AVI, FLV, WebM, WMV, 3GPP.
  - Documents: PDF and CSV only. Convert other documents to text first.
- Google allows 100 MB inline per request, and 50 MB per PDF.
- **Video processing.** A video part can carry `processing: "agentic"`, so the model explores a long video and loads only what the prompt needs. The default is `"static"` (frames at a fixed rate). Only some Gemini models support agentic mode. Other providers ignore the field with a warning.

### OpenRouter

- Images and videos given as web links pass through untouched. Everything else is inlined as base64.
- Audio is always inlined (audio links are downloaded) and sent with its real format: `wav`, `mp3`, `aiff`, `aac`, `ogg`, `flac` or `m4a`. The format comes from `mimeType`, the file extension or the first bytes.
- A QuickTime video is sent as `video/mov`. Supported video types are MP4, MPEG, MOV and WebM. The model and the route limit size and length, and their errors come back as they are.
- A web link the route cannot fetch comes back as a bare "Provider returned error". The SDK adds a hint to that error: a remote image or video link may be the cause, so pass the file itself.
- An image's `resolution` is sent as `image_url.detail` (`low`, `auto`, `high` or `original`). OpenRouter videos ignore it, with a warning.
- When the router reads a PDF, it returns the parsed file as an annotation. The SDK keeps it with the assistant message, saves it with the session and sends it back on the next turns. The same PDF is not parsed again, and not billed again.

### Anthropic

- Images are JPEG, PNG, GIF or WebP. Documents are PDF or plain text. Each is sent as a URL (Anthropic fetches it) or as inline base64. Local files and other URLs are read and inlined.
- Audio, video and any other file type fail before the network with a one-line error.
- Anthropic's limits, which the SDK does not enforce: 128 MB per request, 10 MB and 8,000 px per image, and 600 PDF pages (100 when the model's context window is under 1M tokens).
- `resolution` and `processing` are ignored, with a warning.

## Tips

- Prefer URLs for large media. They are not inlined.
- Restrict local reads with `fileAccess.roots`.
- Never pass untrusted paths without `roots`. A local path outside `roots` throws `SecurityPolicyError`. `[]` denies all local paths, and leaving `roots` unset allows everything.
