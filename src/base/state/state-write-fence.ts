export interface StateWriteFenceContext {
  goalId: string;
  op: string;
  data: unknown;
}

export type StateWriteFence = (context: StateWriteFenceContext) => Promise<void> | void;
