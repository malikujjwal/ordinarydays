import type { TransactionContext } from '@/lib/sqlite/transaction';

export interface TypedReadRepository<Query, Result> {
  read(query: Query): Promise<Result>;
  subscribe(query: Query, listener: () => void): () => void;
  version(query: Query): number;
}

export interface TypedWriteRepository<Command, Result> {
  write(transaction: TransactionContext, command: Command): Promise<Result>;
}

export type TypedRepository<Query, ReadResult, Command, WriteResult> =
  TypedReadRepository<Query, ReadResult> & TypedWriteRepository<Command, WriteResult>;
