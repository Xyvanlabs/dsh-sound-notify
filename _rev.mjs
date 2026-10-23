import { createHash } from "node:crypto"
import { statSync } from "node:fs"
const p = "lib/client.js"
const st = statSync(p)
const framed = (domain, parts) => { const h = createHash("sha1").update(domain).update("\0"); for (const x of parts) h.update(`${Buffer.byteLength(x)}:`).update(x); return h.digest("hex").slice(0,12) }
const rev = framed("plugin-artifact", [String(st.mtimeMs), String(st.ctimeMs), String(st.size)])
console.log(JSON.stringify({ path: p, mtimeMs: st.mtimeMs, ctimeMs: st.ctimeMs, size: st.size, rev }))
