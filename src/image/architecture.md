# src/image/

Image generation: `generateImage` and its pieces. The supported models and their facts are in `../models/image-models.ts`; the wire code of each provider is in `../providers/<provider>.ts` (`Provider.generateImage`).

| File          | What it is                                                                                                                                                                                                                                                                                                                                                              |
| :------------ | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `request.ts`  | `resolveImageRequest`: checks an `ImageOptions` against the model's table entry (aspect ratios, tiers, exact-size rules, quality, format, background, thinking, reference-image count, prompt length, `n`), computes the exact size for models that take one, and returns the final request plus warnings. Pure. `estimateImageCostUsd`, `MAX_IMAGES`.                  |
| `generate.ts` | `generateImage`: model lookup (`ConfigError` with the reason), `setModels` check, request check, warnings on the bus, reference images read (`fileAccess`), cost estimate vs `budget`, parallel requests when `n` exceeds the model's per-request maximum (each under `withProviderSlot`, timeout and abort bounded), usage added up, zero images is a `ProviderError`. |
| `pricing.ts`  | `priceImageUsage`: the cost of one call from the reported tokens and the model's table entry (image output at the image rate, the rest at the text rate), and `sumCosts` for several requests; an unpriced part keeps the cost unknown, never $0.                                                                                                                       |
| `result.ts`   | `GeneratedImage` (bytes, `base64`, `dataUrl`, `save`, `toPart`, small `toJSON`) and `ImageResult`.                                                                                                                                                                                                                                                                      |

## Invariants

- A value outside a model's list is a problem (one `ValidationError` for all of them); a control the model does not have (including `resolution` or `size` on a model that only takes a ratio) is a warning and is dropped. Nothing is guessed and nothing is silently changed.
- The adapter receives a checked request (`ProviderImageRequest`) and `count` never exceeds the model's `imagesPerRequest.max`; it never validates options itself.
- A call that returns has at least one picture. When one parallel request fails the rest are aborted, the first real error is thrown and the finished pictures are on `error.partial.images`.
- `ImageResult` and `GeneratedImage` never put the bytes in JSON.
- Cost: the provider's reported cost wins, else the table prices the reported tokens, else it is unknown (never 0, never a partial sum). Adapters report `outputDetails.imageTokens` (and, when reference images are sent, `inputDetails.imageTokens` / `textTokens`) so the split is exact; Google falls back to the table's tokens per picture.

`GeneratedImage.edit()` / `continueFrom`: `generate.ts` attaches an origin (model, Google interaction id, connection settings) to each picture in a module-private WeakMap (`result.ts`), never in the object or its JSON. A continuation on the same Google model sends `previous_interaction_id`; otherwise the picture is prepended to the reference images before validation.

`tool.ts` (`imageTool`): checks model, `allow` and `defaults` at creation, builds a zod input from the model's own lists, saves under `dir` and returns paths (or `toolContent` with `show`). Its spend is a `UsageTotals` on the returned definition (`imageSpend`, kept by `normalizeToolMap`'s spread), added by `session/usage.ts::addImageCall` and listed by `Agent.usageReport()` as a `fixed` node.
