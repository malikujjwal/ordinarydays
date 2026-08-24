/**
 * `DELETE /v1/lists/:id` answers `200` with the envelope, never `204`, and `data` names
 * what was removed (`api-contract.md` §1, P3-05).
 */
export interface DeletedList {
  listId: string;
}
