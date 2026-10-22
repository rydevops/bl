// Amanatides & Woo voxel traversal. Water is ignored so you can target blocks through it.
import { isTargetable } from './blocks.js';

/**
 * @returns {null | {x,y,z,id,nx,ny,nz,px,py,pz,dist}}  hit block, face normal, and the
 * neighbouring cell (px,py,pz) where a new block would be placed.
 */
export function raycast(world, ox, oy, oz, dx, dy, dz, maxDist = 5) {
  const len = Math.hypot(dx, dy, dz);
  if (len === 0) return null;
  dx /= len; dy /= len; dz /= len;
  let x = Math.floor(ox), y = Math.floor(oy), z = Math.floor(oz);
  const sx = dx > 0 ? 1 : -1, sy = dy > 0 ? 1 : -1, sz = dz > 0 ? 1 : -1;
  const tdx = dx === 0 ? Infinity : Math.abs(1 / dx);
  const tdy = dy === 0 ? Infinity : Math.abs(1 / dy);
  const tdz = dz === 0 ? Infinity : Math.abs(1 / dz);
  let tmx = dx === 0 ? Infinity : ((dx > 0 ? x + 1 - ox : ox - x)) * tdx;
  let tmy = dy === 0 ? Infinity : ((dy > 0 ? y + 1 - oy : oy - y)) * tdy;
  let tmz = dz === 0 ? Infinity : ((dz > 0 ? z + 1 - oz : oz - z)) * tdz;
  let nx = 0, ny = 0, nz = 0, t = 0;

  for (let i = 0; i < 256; i++) {
    const id = world.getBlock(x, y, z);
    if (isTargetable(id) && t <= maxDist) {
      return { x, y, z, id, nx, ny, nz, px: x + nx, py: y + ny, pz: z + nz, dist: t };
    }
    if (tmx < tmy && tmx < tmz) { t = tmx; tmx += tdx; x += sx; nx = -sx; ny = 0; nz = 0; }
    else if (tmy < tmz) { t = tmy; tmy += tdy; y += sy; nx = 0; ny = -sy; nz = 0; }
    else { t = tmz; tmz += tdz; z += sz; nx = 0; ny = 0; nz = -sz; }
    if (t > maxDist) return null;
  }
  return null;
}

/** Look direction for yaw/pitch (yaw 0 looks toward -z, +yaw turns left). */
export function lookDir(yaw, pitch) {
  const cp = Math.cos(pitch);
  return [-Math.sin(yaw) * cp, Math.sin(pitch), -Math.cos(yaw) * cp];
}
