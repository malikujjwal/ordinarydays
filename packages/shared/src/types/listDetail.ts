import type { ListDetailItem } from './listDetailItem.js';
import type { ListView } from './listView.js';

/**
 * `GET /v1/lists/:id` (P3-05, `api-contract.md` §2.7): META always; the fenced first item
 * page and its rank-version-bound opaque cursor only when `includeItems=true` asked for
 * them. Later item pages go through `GET /v1/lists/:id/items?cursor=` (P3-08).
 */
export interface ListDetail {
  list: ListView;
  items?: ListDetailItem[];
  nextCursor?: string;
}
