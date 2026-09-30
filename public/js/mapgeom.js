// Shared map geometry helpers — used by the browser (auto-trace) and by the
// server (export). Everything here is plain arrays of [x, y] points; rings
// are stored open (the first point is not repeated at the end).
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.MapGeom = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    // Signed shoelace area. In image coordinates (y down) a positive area
    // means the ring runs clockwise on screen.
    function ringArea(pts) {
        let a = 0;
        for (let i = 0; i < pts.length; i++) {
            const [x1, y1] = pts[i];
            const [x2, y2] = pts[(i + 1) % pts.length];
            a += x1 * y2 - x2 * y1;
        }
        return a / 2;
    }

    function ringBounds(pts) {
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const [x, y] of pts) {
            if (x < minX) minX = x;
            if (y < minY) minY = y;
            if (x > maxX) maxX = x;
            if (y > maxY) maxY = y;
        }
        return { minX, minY, maxX, maxY };
    }

    // Drop repeated points and points that sit on the straight line between
    // their neighbours (including out-and-back spikes).
    function cleanRing(points) {
        let pts = points.slice();
        let changed = true;
        while (changed && pts.length > 2) {
            changed = false;
            const out = [];
            const n = pts.length;
            for (let i = 0; i < n; i++) {
                const a = out.length ? out[out.length - 1] : pts[(i - 1 + n) % n];
                const b = pts[i];
                const c = pts[(i + 1) % n];
                if (a[0] === b[0] && a[1] === b[1]) { changed = true; continue; }
                if ((b[0] - a[0]) * (c[1] - a[1]) === (c[0] - a[0]) * (b[1] - a[1])) { changed = true; continue; }
                out.push(b);
            }
            pts = out;
        }
        return pts;
    }

    function isRectilinear(pts, eps) {
        const e = eps || 1e-9;
        for (let i = 0; i < pts.length; i++) {
            const a = pts[i], b = pts[(i + 1) % pts.length];
            if (Math.abs(a[0] - b[0]) > e && Math.abs(a[1] - b[1]) > e) return false;
        }
        return pts.length >= 4;
    }

    // Straighten an axis-aligned ring by collapsing every edge shorter than
    // `tol`, shortest first: the short edge's shorter neighbour slides onto
    // the longer neighbour's line, so door-jamb ticks, pilasters and
    // wall-thickness steps vanish and the long wall runs keep their place.
    function rectilinearSimplify(points, tol) {
        let pts = cleanRing(points);
        let guard = pts.length * 4;
        while (pts.length > 4 && guard-- > 0) {
            const n = pts.length;
            let best = -1, bestLen = tol;
            for (let k = 0; k < n; k++) {
                const a = pts[k], b = pts[(k + 1) % n];
                const len = Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]);
                if (len < bestLen) { bestLen = len; best = k; }
            }
            if (best < 0) break;
            const i0 = (best - 1 + n) % n, i1 = best, i2 = (best + 1) % n, i3 = (best + 2) % n;
            const p0 = pts[i0], p1 = pts[i1], p2 = pts[i2], p3 = pts[i3];
            const lenA = Math.abs(p0[0] - p1[0]) + Math.abs(p0[1] - p1[1]);
            const lenB = Math.abs(p2[0] - p3[0]) + Math.abs(p2[1] - p3[1]);
            const vertical = p1[0] === p2[0];
            let drop;
            if (lenA <= lenB) {
                pts[i0] = vertical ? [p0[0], p2[1]] : [p2[0], p0[1]];
                drop = i1;
            } else {
                pts[i3] = vertical ? [p3[0], p1[1]] : [p1[0], p3[1]];
                drop = i2;
            }
            pts.splice(drop, 1);
            pts = cleanRing(pts);
        }
        return pts;
    }

    // Move every edge of an axis-aligned ring outward by d (inward if d < 0).
    function offsetRectilinear(points, d) {
        const pts = cleanRing(points);
        const n = pts.length;
        if (n < 4 || !d) return pts;
        const sign = ringArea(pts) > 0 ? 1 : -1;
        const normal = (a, b) => {
            const dx = Math.sign(b[0] - a[0]), dy = Math.sign(b[1] - a[1]);
            return [sign * dy, -sign * dx];
        };
        const out = [];
        for (let i = 0; i < n; i++) {
            const prev = pts[(i - 1 + n) % n], cur = pts[i], next = pts[(i + 1) % n];
            const n1 = normal(prev, cur), n2 = normal(cur, next);
            out.push([cur[0] + d * (n1[0] + n2[0]), cur[1] + d * (n1[1] + n2[1])]);
        }
        return out;
    }

    // Douglas-Peucker on an open path, with a cheap collinear collapse first.
    function simplifyPath(points, epsilon) {
        if (points.length < 3) return points;
        const collapsed = [points[0]];
        for (let i = 1; i < points.length - 1; i++) {
            const [ax, ay] = collapsed[collapsed.length - 1];
            const [bx, by] = points[i];
            const [cx, cy] = points[i + 1];
            if ((bx - ax) * (cy - ay) !== (cx - ax) * (by - ay)) collapsed.push(points[i]);
        }
        collapsed.push(points[points.length - 1]);

        const keep = new Uint8Array(collapsed.length);
        keep[0] = keep[collapsed.length - 1] = 1;
        const stack = [[0, collapsed.length - 1]];
        while (stack.length) {
            const [a, b] = stack.pop();
            const [ax, ay] = collapsed[a];
            const [bx, by] = collapsed[b];
            const dx = bx - ax, dy = by - ay;
            const len = Math.hypot(dx, dy) || 1;
            let worst = -1, worstDist = epsilon;
            for (let i = a + 1; i < b; i++) {
                const d = Math.abs(dx * (ay - collapsed[i][1]) - (ax - collapsed[i][0]) * dy) / len;
                if (d > worstDist) { worstDist = d; worst = i; }
            }
            if (worst >= 0) {
                keep[worst] = 1;
                stack.push([a, worst], [worst, b]);
            }
        }
        return collapsed.filter((_, i) => keep[i]);
    }

    // Douglas-Peucker on a closed ring: split at the two mutually farthest
    // points so the arbitrary start vertex doesn't survive as a false corner.
    function simplifyRing(points, epsilon) {
        if (points.length < 5) return points;
        let far = 0, farDist = -1;
        for (let i = 1; i < points.length; i++) {
            const d = Math.hypot(points[i][0] - points[0][0], points[i][1] - points[0][1]);
            if (d > farDist) { farDist = d; far = i; }
        }
        let start = 0, startDist = -1;
        for (let i = 0; i < points.length; i++) {
            const d = Math.hypot(points[i][0] - points[far][0], points[i][1] - points[far][1]);
            if (d > startDist) { startDist = d; start = i; }
        }
        const rot = points.slice(start).concat(points.slice(0, start));
        const split = (far - start + points.length) % points.length;
        const a = simplifyPath(rot.slice(0, split + 1), epsilon);
        const b = simplifyPath(rot.slice(split).concat([rot[0]]), epsilon);
        return a.slice(0, -1).concat(b.slice(0, -1));
    }

    // Corner-cutting smoothing for traced curves (closed ring). Each corner
    // is cut back by a quarter of its edges but never more than maxCut, so
    // curves (many short segments) round off while long straight edges stay
    // straight right up to their corners.
    function chaikin(points, iterations, maxCut) {
        let pts = points;
        for (let it = 0; it < iterations; it++) {
            const out = [];
            for (let i = 0; i < pts.length; i++) {
                const a = pts[i], b = pts[(i + 1) % pts.length];
                const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
                const t = len > 0 && maxCut ? Math.min(0.25, maxCut / len) : 0.25;
                out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
                out.push([b[0] + (a[0] - b[0]) * t, b[1] + (a[1] - b[1]) * t]);
            }
            pts = out;
        }
        return pts;
    }

    // Square up a traced polygon: edges within ~14° of horizontal or
    // vertical become exactly so; genuine diagonals (chamfered corners) are
    // left alone.
    function snapAxes(points) {
        const n = points.length;
        if (n < 3) return points;
        const kind = [], coord = [];
        for (let i = 0; i < n; i++) {
            const a = points[i], b = points[(i + 1) % n];
            const dx = Math.abs(b[0] - a[0]), dy = Math.abs(b[1] - a[1]);
            if (dx >= dy * 4) { kind.push('h'); coord.push((a[1] + b[1]) / 2); }
            else if (dy >= dx * 4) { kind.push('v'); coord.push((a[0] + b[0]) / 2); }
            else { kind.push('d'); coord.push(0); }
        }
        const out = [];
        for (let i = 0; i < n; i++) {
            const p = (i - 1 + n) % n;
            let [x, y] = points[i];
            if (kind[p] === 'h' && kind[i] === 'h') y = (coord[p] + coord[i]) / 2;
            else if (kind[p] === 'h') y = coord[p];
            else if (kind[i] === 'h') y = coord[i];
            if (kind[p] === 'v' && kind[i] === 'v') x = (coord[p] + coord[i]) / 2;
            else if (kind[p] === 'v') x = coord[p];
            else if (kind[i] === 'v') x = coord[i];
            out.push([x, y]);
        }
        return cleanRing(out);
    }

    // Move every edge of a polygon outward by d (inward if d < 0), mitring
    // the corners (the mitre is capped so sharp corners don't spike).
    function offsetPolygon(points, d) {
        const pts = cleanRing(points);
        const n = pts.length;
        if (n < 3 || !d) return pts;
        const sign = ringArea(pts) > 0 ? 1 : -1;
        const normal = (a, b) => {
            const dx = b[0] - a[0], dy = b[1] - a[1];
            const len = Math.hypot(dx, dy) || 1;
            return [sign * dy / len, -sign * dx / len];
        };
        const out = [];
        for (let i = 0; i < n; i++) {
            const n1 = normal(pts[(i - 1 + n) % n], pts[i]);
            const n2 = normal(pts[i], pts[(i + 1) % n]);
            const bx = n1[0] + n2[0], by = n1[1] + n2[1];
            const denom = 1 + n1[0] * n2[0] + n1[1] * n2[1];
            const scale = d / Math.max(denom, 0.35);
            out.push([pts[i][0] + bx * scale, pts[i][1] + by * scale]);
        }
        return out;
    }

    // Even-odd point test against one or more rings.
    function pointInRings(x, y, rings) {
        let inside = false;
        for (const ring of rings) {
            for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
                const xi = ring[i][0], yi = ring[i][1];
                const xj = ring[j][0], yj = ring[j][1];
                if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
            }
        }
        return inside;
    }

    // Every boundary loop of a grid mask — the outer contour plus one loop
    // per interior hole — walking the cracks between cells with the inside
    // kept on the right, so outer loops and hole loops wind in opposite
    // directions. Where two cells touch only at a corner the walk turns
    // toward the inside cell's own side, which keeps each loop simple.
    function traceLoops(isInside, minX, minY, maxX, maxY) {
        const span = maxX - minX + 3;
        const key = (x, y) => (y - minY) * span + (x - minX);
        const nextEdge = new Map();
        const addEdge = (x1, y1, x2, y2) => {
            const k = key(x1, y1);
            const list = nextEdge.get(k);
            if (list) list.push(x2, y2); else nextEdge.set(k, [x2, y2]);
        };
        const inside = (x, y) => x >= minX && x <= maxX && y >= minY && y <= maxY && isInside(x, y);
        for (let y = minY; y <= maxY; y++) {
            for (let x = minX; x <= maxX; x++) {
                if (!inside(x, y)) continue;
                if (!inside(x, y - 1)) addEdge(x, y, x + 1, y);
                if (!inside(x + 1, y)) addEdge(x + 1, y, x + 1, y + 1);
                if (!inside(x, y + 1)) addEdge(x + 1, y + 1, x, y + 1);
                if (!inside(x - 1, y)) addEdge(x, y + 1, x, y);
            }
        }
        const loops = [];
        for (const [startKey, startList] of nextEdge) {
            while (startList.length) {
                const sy = Math.floor(startKey / span) + minY;
                const sx = startKey - (sy - minY) * span + minX;
                const pts = [];
                let px = sx, py = sy, cx = sx, cy = sy;
                let first = true;
                for (;;) {
                    const list = nextEdge.get(key(cx, cy));
                    if (!list || list.length === 0) break;
                    let pick = list.length - 2;
                    if (list.length > 2 && !first) {
                        // Pinch point: prefer the right turn (stay on the same cell).
                        const dx = cx - px, dy = cy - py;
                        for (let c = 0; c < list.length; c += 2) {
                            const ex = list[c] - cx, ey = list[c + 1] - cy;
                            if (ex === -dy && ey === dx) { pick = c; break; }
                        }
                    }
                    const nx = list[pick], ny = list[pick + 1];
                    list.splice(pick, 2);
                    pts.push([cx, cy]);
                    px = cx; py = cy; cx = nx; cy = ny;
                    first = false;
                    if (cx === sx && cy === sy) break;
                }
                if (pts.length >= 4) loops.push(pts);
            }
        }
        return loops;
    }

    // Turn a set of occupied cells on an irregular grid (xs/ys are the sorted
    // grid-line coordinates, occ is row-major over the cells between them)
    // into simple polygons. A connected piece that encloses holes is cut
    // along the left edge of each hole, because Microsoft Places' importer
    // rejects polygons with interior rings.
    function gridPolygons(xs, ys, occ) {
        const nx = xs.length - 1, ny = ys.length - 1;
        const result = [];
        if (nx < 1 || ny < 1) return result;

        const label = new Int32Array(nx * ny);
        const labelPieces = (cuts) => {
            label.fill(0);
            const pieces = [];
            const stack = [];
            const slabOf = cuts ? (x) => { let s = 0; while (s < cuts.length && x >= cuts[s]) s++; return s; } : null;
            for (let start = 0; start < nx * ny; start++) {
                if (!occ[start] || label[start]) continue;
                const id = pieces.length + 1;
                const piece = { id, minX: nx, minY: ny, maxX: 0, maxY: 0, count: 0 };
                const slab = slabOf ? slabOf(start % nx) : 0;
                stack.push(start);
                while (stack.length) {
                    const i = stack.pop();
                    if (label[i] || !occ[i]) continue;
                    const x = i % nx, y = (i / nx) | 0;
                    if (slabOf && slabOf(x) !== slab) continue;
                    label[i] = id;
                    piece.count++;
                    if (x < piece.minX) piece.minX = x;
                    if (x > piece.maxX) piece.maxX = x;
                    if (y < piece.minY) piece.minY = y;
                    if (y > piece.maxY) piece.maxY = y;
                    if (x > 0) stack.push(i - 1);
                    if (x < nx - 1) stack.push(i + 1);
                    if (y > 0) stack.push(i - nx);
                    if (y < ny - 1) stack.push(i + nx);
                }
                pieces.push(piece);
            }
            return pieces;
        };
        const loopsOf = (piece) => traceLoops(
            (x, y) => label[y * nx + x] === piece.id,
            piece.minX, piece.minY, piece.maxX, piece.maxY);
        const toCoords = (loop) => cleanRing(loop.map(([gx, gy]) => [xs[gx], ys[gy]]));

        // First pass: find which pieces have holes and where to cut them.
        const cutSet = new Set();
        let anyHoles = false;
        const firstPass = labelPieces(null);
        const firstLoops = firstPass.map(loopsOf);
        firstPass.forEach((piece, p) => {
            const loops = firstLoops[p];
            if (loops.length <= 1) return;
            anyHoles = true;
            let outer = 0, outerArea = -1;
            loops.forEach((l, i) => { const a = Math.abs(ringArea(l)); if (a > outerArea) { outerArea = a; outer = i; } });
            loops.forEach((l, i) => {
                if (i === outer) return;
                let hMin = Infinity;
                for (const [gx] of l) if (gx < hMin) hMin = gx;
                cutSet.add(hMin);
            });
        });
        if (!anyHoles) {
            firstPass.forEach((piece, p) => {
                const ring = toCoords(firstLoops[p][0]);
                if (ring.length >= 3) result.push(ring);
            });
            return result;
        }

        const cuts = [...cutSet].sort((a, b) => a - b);
        for (const piece of labelPieces(cuts)) {
            const loops = loopsOf(piece);
            if (!loops.length) continue;
            let outer = loops[0], outerArea = Math.abs(ringArea(loops[0]));
            for (const l of loops) { const a = Math.abs(ringArea(l)); if (a > outerArea) { outerArea = a; outer = l; } }
            const ring = toCoords(outer);
            if (ring.length >= 3) result.push(ring);
        }
        return result;
    }

    // Sorted distinct coordinates (merging values closer than eps).
    function gridLines(values, eps) {
        const sorted = values.slice().sort((a, b) => a - b);
        const out = [];
        for (const v of sorted) {
            if (!out.length || v - out[out.length - 1] > (eps || 1e-9)) out.push(v);
        }
        return out;
    }

    // Build the cell grid spanned by a set of rings and mark each cell by a
    // test on its centre point. Exact for axis-aligned geometry.
    function gridFromRings(ringSets, test, extraX, extraY) {
        const vx = (extraX || []).slice(), vy = (extraY || []).slice();
        for (const rings of ringSets) {
            for (const ring of rings) {
                for (const [x, y] of ring) { vx.push(x); vy.push(y); }
            }
        }
        const xs = gridLines(vx), ys = gridLines(vy);
        const nx = Math.max(0, xs.length - 1), ny = Math.max(0, ys.length - 1);
        const occ = new Uint8Array(nx * ny);
        for (let j = 0; j < ny; j++) {
            const cy = (ys[j] + ys[j + 1]) / 2;
            for (let i = 0; i < nx; i++) {
                if (test((xs[i] + xs[i + 1]) / 2, cy)) occ[j * nx + i] = 1;
            }
        }
        return { xs, ys, occ, nx, ny };
    }

    // Split an axis-aligned polygon with holes (rings[0] outer, the rest
    // holes) into simple polygons, exactly.
    function splitRectilinearHoles(rings) {
        const grid = gridFromRings([rings], (x, y) => pointInRings(x, y, rings));
        return gridPolygons(grid.xs, grid.ys, grid.occ);
    }

    // Rectangle with an independent radius on each corner
    // (order: top-left, top-right, bottom-right, bottom-left).
    function roundedRect(x0, y0, x1, y1, radii) {
        const w = x1 - x0, h = y1 - y0;
        const lim = Math.min(w, h) / 2;
        const r = radii.map(v => Math.max(0, Math.min(v || 0, lim)));
        const pts = [];
        const arc = (cx, cy, radius, from) => {
            const steps = Math.max(2, Math.min(8, Math.ceil(radius * 1.2)));
            for (let s = 0; s <= steps; s++) {
                const t = (from + s / steps) * Math.PI / 2;
                pts.push([cx + radius * Math.cos(t), cy + radius * Math.sin(t)]);
            }
        };
        // Angles measured with y down: 180°→270° is the top-left corner.
        if (r[0] < 0.35) pts.push([x0, y0]); else arc(x0 + r[0], y0 + r[0], r[0], 2);
        if (r[1] < 0.35) pts.push([x1, y0]); else arc(x1 - r[1], y0 + r[1], r[1], 3);
        if (r[2] < 0.35) pts.push([x1, y1]); else arc(x1 - r[2], y1 - r[2], r[2], 0);
        if (r[3] < 0.35) pts.push([x0, y1]); else arc(x0 + r[3], y1 - r[3], r[3], 1);
        return pts;
    }

    // 3D effect. Microsoft Places draws flat polygons in one fill colour, so
    // depth has to come from geometry: every wall is raised, as if the map
    // were viewed from the south at a steep angle. A wall is whatever part
    // of the footprint no floor unit covers (minus doorways). Each wall's
    // top is drawn `height` further north than its base, and the strip in
    // between — the south face the viewer would see — becomes its own
    // polygon. Tops and faces are computed on one grid, so a face that a
    // nearer wall would hide is simply not produced.
    //
    //   footprint: ring            floors: [[outer, ...holes], ...]
    //   doorways:  [{x0, y0, x1, y1}] boxes kept free of wall
    // y grows downward (south). Returns { tops, faces }, lists of rings.
    function extrudeWalls(footprint, floors, doorways, height) {
        const boxes = floors.map(rings => ringBounds(rings[0]));
        const vx = [], vy = [];
        const addRing = ring => { for (const [x, y] of ring) { vx.push(x); vy.push(y); vy.push(y - height); } };
        addRing(footprint);
        for (const rings of floors) rings.forEach(addRing);
        for (const d of doorways) {
            vx.push(d.x0, d.x1);
            vy.push(d.y0, d.y1, d.y0 - height, d.y1 - height);
        }
        const span = ringBounds(footprint);
        const eps = Math.max(span.maxX - span.minX, span.maxY - span.minY) * 1e-7;
        const xs = gridLines(vx, eps), ys = gridLines(vy, eps);
        const nx = xs.length - 1, ny = ys.length - 1;
        if (nx < 1 || ny < 1) return { tops: [], faces: [] };

        const wall = new Uint8Array(nx * ny);
        for (let j = 0; j < ny; j++) {
            const cy = (ys[j] + ys[j + 1]) / 2;
            for (let i = 0; i < nx; i++) {
                const cx = (xs[i] + xs[i + 1]) / 2;
                if (!pointInRings(cx, cy, [footprint])) continue;
                let open = false;
                for (const d of doorways) {
                    if (cx > d.x0 && cx < d.x1 && cy > d.y0 && cy < d.y1) { open = true; break; }
                }
                for (let f = 0; f < floors.length && !open; f++) {
                    const b = boxes[f];
                    if (cx < b.minX || cx > b.maxX || cy < b.minY || cy > b.maxY) continue;
                    if (pointInRings(cx, cy, floors[f])) open = true;
                }
                if (!open) wall[j * nx + i] = 1;
            }
        }
        // A cell shows a wall top if there is wall `height` south of it, and
        // a wall face if there is wall anywhere in between.
        const top = new Uint8Array(nx * ny), face = new Uint8Array(nx * ny);
        for (let j = 0; j < ny; j++) {
            const cy = (ys[j] + ys[j + 1]) / 2;
            for (let i = 0; i < nx; i++) {
                const cx = (xs[i] + xs[i + 1]) / 2;
                if (!pointInRings(cx, cy, [footprint])) continue;
                let swept = false, capped = false;
                for (let jj = j; jj < ny && ys[jj] < cy + height; jj++) {
                    if (!wall[jj * nx + i]) continue;
                    swept = true;
                    if (ys[jj] <= cy + height && ys[jj + 1] >= cy + height) capped = true;
                }
                if (capped) top[j * nx + i] = 1;
                else if (swept) face[j * nx + i] = 1;
            }
        }
        return { tops: gridPolygons(xs, ys, top), faces: gridPolygons(xs, ys, face) };
    }

    // Hatch a (rectilinear) face with thin horizontal slivers, `spacing`
    // apart on a shared grid so lines on neighbouring faces line up. Places
    // strokes every polygon, so a sliver reads as a line — the only way to
    // get a darker tone than the standard fill.
    function hatchRing(ring, spacing, thickness) {
        const out = [];
        const grid = gridFromRings([[ring]], (x, y) => pointInRings(x, y, [ring]));
        const { xs, ys, occ, nx, ny } = grid;
        for (let j = 0; j < ny; j++) {
            for (let k = Math.ceil(ys[j] / spacing); k * spacing < ys[j + 1] - thickness; k++) {
                const y = k * spacing;
                if (y <= ys[j]) continue;
                let start = -1;
                for (let i = 0; i <= nx; i++) {
                    const on = i < nx && occ[j * nx + i];
                    if (on && start < 0) start = i;
                    if (!on && start >= 0) {
                        out.push([[xs[start], y], [xs[i], y], [xs[i], y + thickness], [xs[start], y + thickness]]);
                        start = -1;
                    }
                }
            }
        }
        return out;
    }

    return {
        ringArea, ringBounds, cleanRing, isRectilinear,
        rectilinearSimplify, offsetRectilinear,
        simplifyPath, simplifyRing, chaikin, snapAxes, offsetPolygon,
        pointInRings, traceLoops,
        gridLines, gridFromRings, gridPolygons, splitRectilinearHoles,
        roundedRect, extrudeWalls, hatchRing
    };
});
