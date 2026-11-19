/** Projection shape: "v" scalar, "*" anything, {o} object with known keys, {a} array. */
export type Shape = "v" | "*" | { o: { [key: string]: Shape } } | { a: Shape };

export interface QueryParamRule {
  readonly name: string;
  readonly in: string;
  readonly type: string;
  readonly required?: boolean;
  readonly enum?: readonly unknown[];
  readonly format?: string;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly minLength?: number;
  readonly maxItems?: number;
  readonly items?: {
    readonly type: string;
    readonly format?: string;
    readonly pattern?: string;
    readonly enum?: readonly unknown[];
  };
}

export interface OperationSpec {
  readonly method: string;
  readonly path: string;
  readonly tag: string;
  readonly role: string | null;
  readonly query: readonly QueryParamRule[];
  readonly pathParams: readonly string[];
  readonly headers: readonly string[];
  readonly hasBody: boolean;
  readonly summary: string;
  readonly bodyRequired: boolean;
  readonly response: Shape | null;
}

export type OperationTable = { readonly [operationId: string]: OperationSpec };
