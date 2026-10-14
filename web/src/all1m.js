// PROTOTYPE (proto-ghost branch), engine A preview: the whole city at 1 m, loaded once, no levels, no streaming.
// (No compact vertex format or temporal anti-aliasing yet: this is today's meshes, all of them.) ?all1m=1
export async function installAll1m({ streamer: S, status }) {
  const d = S.dims[1], ps = [];
  S.update = () => {}; // nothing streams, nothing swaps
  for (const n of S.nodes.values()) if (n.mesh) n.mesh.visible = false;
  let done = 0;
  for (let ty = 0; ty < d.ny; ty++) for (let tx = 0; tx < d.nx; tx++) ps.push(S.request(1, tx, ty, 1e9, true).then(() => { status?.(`Loading the whole city at 1 m… ${++done} / ${d.nx * d.ny}`); }));
  S.pump();
  const pump = setInterval(() => S.pump(), 50);
  await Promise.all(ps);
  clearInterval(pump);
  let tris = 0;
  for (const n of S.nodes.values()) { if (!n.mesh) continue; n.mesh.visible = n.s === 1; if (n.s === 1) tris += n.tris; }
  S.tris = tris;
}
