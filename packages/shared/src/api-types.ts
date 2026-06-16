// Canonical API response contract for RelayRoom. A small, stable response shape
// proven across years of production use.
// Used by: web modules, server actions, AND the Hono server — all API returns share this shape.

type WithRequired<T, K extends keyof T = never> = Omit<T, K> &
  Required<Pick<T, K>>;

export interface ApiPaginationProps {
  page: number;
  limit: number;
}

export interface ApiPropsWithFilter<T, K extends keyof T = never> {
  filters: WithRequired<Partial<T>, K>;
}

export interface ApiPaginationPropsWithFilter<
  T,
  K extends keyof T = never,
> extends ApiPaginationProps {
  filters: WithRequired<Partial<T>, K>;
}

export interface ApiResult {
  result: boolean;
  message?: string | null;
}

interface ApiResultWithItemResultTrue<T> extends ApiResult {
  result: true;
  item: T;
}
interface ApiResultWithItemResultFalse extends ApiResult {
  result: false;
  message: string;
  item?: null;
}
export type ApiResultWithItem<T> =
  | ApiResultWithItemResultTrue<T>
  | ApiResultWithItemResultFalse;

interface ApiResultWithItemsResultTrue<T> extends ApiResult {
  result: true;
  totalCount: number;
  items: T[];
}

interface ApiResultWithItemsResultFalse extends ApiResult {
  result: false;
  message: string;
  totalCount?: null;
  items?: null;
}

export type ApiResultWithItems<T> =
  | ApiResultWithItemsResultTrue<T>
  | ApiResultWithItemsResultFalse;
