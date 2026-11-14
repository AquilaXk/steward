# Third-Party Notices and Upstream References

Steward (`steward`) maintains zero third-party runtime or development dependencies and runs strictly on Node.js 22+ built-in modules (`node:crypto`, `node:fs`, `node:path`, `node:child_process`, `node:string_decoder`).

Before implementing or refactoring security-critical and performance-sensitive internals, each subsystem underwent a three-step open-source evaluation:

1. **Permissive Package Check**: Evaluate permissive OSS packages (`Apache-2.0`, `BSD-3-Clause`, `MIT`) and reject copyleft (`GPL`/`AGPL`) or heavy dependency trees.
2. **Runtime Built-In Check**: Prefer native Node.js 22+ standard library primitives (`node:crypto`, `node:string_decoder`, TypedArrays) where equivalent functionality exists without external dependencies.
3. **Bounded Adaptation**: Where built-ins do not provide specialized behavior (shell lexing, character-class matching, rule indexing, 32-bit word bitsets), adapt core algorithms from high-star permissive upstream references with strict Fail-Closed bounds (step limits, brace expansion limits, byte limits) and bit/word-level optimizations.

---

## Upstream Components and Adapted Algorithms

### 1. Daniel Lemire et al. — `lemire/FastBitSet.js`
- **Source**: <https://github.com/lemire/FastBitSet.js>
- **License**: Apache License 2.0
- **Copyright**: `(c) the authors`
- **Steward Usage (`src/index-cache.mjs`)**: `Uint32Array` 32-bit word bitset layout, 8-way unrolled multi-filter bitwise intersection, and `31 - Math.clz32(word)` reverse highest-set-bit iteration.

### 2. Open Policy Agent — `open-policy-agent/opa`
- **Source**: <https://github.com/open-policy-agent/opa>
- **License**: Apache License 2.0
- **Copyright**: `Copyright 2017 The OPA Authors. All rights reserved.`
- **Steward Usage (`src/engine.mjs`)**: Rule precompilation, event-mask indexing, and indexed rule selection prior to rule-body predicate checks.

### 3. Cedar Policy — `cedar-policy/cedar`
- **Source**: <https://github.com/cedar-policy/cedar>
- **License**: Apache License 2.0
- **Copyright**: `Copyright Cedar Contributors`
- **Steward Usage (`src/engine.mjs`)**: Deterministic forbid-overrides-permit (deny-first) short-circuit policy evaluation ordering.

### 4. Daniel Martí — `mvdan/sh`
- **Source**: <https://github.com/mvdan/sh>
- **License**: BSD-3-Clause
- **Copyright**: `Copyright (c) 2016, Daniel Martí. All rights reserved.`
- **Steward Usage (`src/matcher.mjs`)**: Multi-character shell operator tokenization (`|&`, `&>`, `&>>`, `<<<`, `;;&`, `;&`), ANSI-C `$'...'` escape decoding, `$"..."` locale quoting, and Fail-Closed bounded unquoted brace expansion (`{a,b}` up to 32 expanded targets).

### 5. The Go Authors — `golang/go` (`path/filepath/match.go`)
- **Source**: <https://github.com/golang/go>
- **License**: BSD-3-Clause
- **Copyright**: `Copyright 2009 The Go Authors.`
- **Steward Usage (`src/matcher.mjs`)**: Raw codepoint character-class range bounds evaluated before ASCII case folding (preventing inverted `[Z-a]` ranges) and UTF-16 surrogate-pair advancement in bracket scanning.

### 6. Model Context Protocol — `modelcontextprotocol/typescript-sdk`
- **Source**: <https://github.com/modelcontextprotocol/typescript-sdk>
- **License**: Apache License 2.0 / MIT License
- **Copyright**: `Copyright (c) 2024-2025 Model Context Protocol a Series of LF Projects, LLC.`
- **Steward Usage (`src/adapters/mcp.mjs`)**: Line-delimited JSON-RPC stdio framing with incremental UTF-8 multi-byte decoding across chunk boundaries (`StringDecoder`).

---

## Verbatim License Texts

### Apache License 2.0

See [LICENSE](./LICENSE) in the repository root for the full text of the Apache License, Version 2.0 (applicable to Steward as well as `lemire/FastBitSet.js`, `open-policy-agent/opa`, `cedar-policy/cedar`, and new code in `modelcontextprotocol/typescript-sdk`).

---

### BSD-3-Clause (`mvdan/sh`)

```text
Copyright (c) 2016, Daniel Martí. All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are
met:

   * Redistributions of source code must retain the above copyright
notice, this list of conditions and the following disclaimer.
   * Redistributions in binary form must reproduce the above
copyright notice, this list of conditions and the following disclaimer
in the documentation and/or other materials provided with the
distribution.
   * Neither the name of the copyright holder nor the names of its
contributors may be used to endorse or promote products derived from
this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
"AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR
A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT
OWNER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT
LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE,
DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY
THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
(INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

---

### BSD-3-Clause (`golang/go`)

```text
Copyright 2009 The Go Authors.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are
met:

   * Redistributions of source code must retain the above copyright
notice, this list of conditions and the following disclaimer.
   * Redistributions in binary form must reproduce the above
copyright notice, this list of conditions and the following disclaimer
in the documentation and/or other materials provided with the
distribution.
   * Neither the name of Google LLC nor the names of its
contributors may be used to endorse or promote products derived from
this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
"AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR
A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT
OWNER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT
LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE,
DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY
THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
(INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

---

### Model Context Protocol Transition & MIT License Notice (`modelcontextprotocol/typescript-sdk`)

```text
The MCP project is undergoing a licensing transition from the MIT License to the Apache License, Version 2.0 ("Apache-2.0"). All new code and specification contributions to the project are licensed under Apache-2.0. Documentation contributions (excluding specifications) are licensed under CC-BY-4.0.

Contributions for which relicensing consent has been obtained are licensed under Apache-2.0. Contributions made by authors who originally licensed their work under the MIT License and who have not yet granted explicit permission to relicense remain licensed under the MIT License.

No rights beyond those granted by the applicable original license are conveyed for such contributions.

MIT License

Copyright (c) 2024-2025 Model Context Protocol a Series of LF Projects, LLC.

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
```
