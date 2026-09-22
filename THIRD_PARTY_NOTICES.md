# Third-party notices

## SoL-Pi

SoL-DSH adapts algorithm design and portions of source from
[SoL-Pi](https://github.com/NVIDIA/SoL-Pi), Copyright (c) 2026 NVIDIA CORPORATION
& AFFILIATES, licensed under the MIT License.

Adapted files carry the original SPDX copyright header and an adaptation note:

| SoL-DSH file | SoL-Pi origin |
|---|---|
| `src/shared/digest.ts` | `src/sol-pi/extensions/evidence-preserving-reducer/config.ts` (hashing and record helpers) |
| `src/reducer/config.ts` | `src/sol-pi/extensions/evidence-preserving-reducer/config.ts` |
| `src/reducer/receipt.ts` | `src/sol-pi/extensions/evidence-preserving-reducer/receipt.ts` |
| `src/reducer/source.ts` | `src/sol-pi/extensions/evidence-preserving-reducer/candidate.ts` |
| `src/reducer/provider.ts` | `src/sol-pi/extensions/evidence-preserving-reducer/provider.ts` |
| `src/observation-pack/*` | `src/sol-pi/extensions/observation-pack/*` (algorithm design; the mechanism differs, see the README) |

What changed: the reduction policy is a Cordis/Schemastery `Config` rather than
a `sol-pi.json` file; source identity and size are a purely computed digest
rather than a filesystem archive object; the complete log is recovered from the
harness bash tool's canonical `spillPath`; the artifact is a harness session
spill rather than a project-owned directory; and the audit trail uses
`ctx.logger` rather than non-context session entries.

ObservationPack is the larger divergence: SoL-Pi rewrites the per-request
message projection, while SoL-DSH appends a `compaction/prune` shadow-price
event and a `tool/result` surface replacement, because an out-of-tree plugin
cannot write the plugin-owned event a harness message projection would require.
The shared part is the policy — send a large result in full for its first few
requests, then replace it with a retrievable placeholder.

### MIT License

Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
