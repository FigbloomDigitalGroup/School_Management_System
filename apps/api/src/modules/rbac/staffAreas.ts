import type { Tx } from "../../db/sql.js";
import { ADMIN_AREAS, isAdminArea, type AdminArea } from "../identity/roles.js";

export interface StaffAreasRow {
  userId: string;
  areas: AdminArea[];
}

/**
 * Who holds admin areas in a school, and which (the read side of `PUT /v1/rbac/staff-areas`): one row per person who holds at
 * least one area granted directly to them, ordered by user id (keyset). Areas come in the catalogue's order. Areas a person
 * would hold through a school role are not here: school roles have no write path in this API.
 */
export async function listStaffAreasPage(
  tx: Tx,
  input: { tenantId: string; limit: number; afterUserId?: string | null },
): Promise<StaffAreasRow[]> {
  const params: unknown[] = [input.tenantId];
  let keyset = "";
  if (input.afterUserId) {
    params.push(input.afterUserId);
    keyset = `AND user_id > $${params.length}::uuid`;
  }
  params.push(input.limit);
  const result = await tx.query<{ user_id: string; areas: string[] }>(
    `SELECT user_id, array_agg(area ORDER BY area) AS areas
       FROM staff_area_grants
      WHERE tenant_id = $1
      ${keyset}
      GROUP BY user_id
      ORDER BY user_id
      LIMIT $${params.length}`,
    params,
  );
  return result.rows.map((r) => {
    const held = new Set(r.areas.filter(isAdminArea));
    return { userId: r.user_id, areas: ADMIN_AREAS.filter((a) => held.has(a)) };
  });
}
