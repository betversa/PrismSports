import { createClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anon = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

export const missingSupabaseVars = [
  !url ? "VITE_SUPABASE_URL" : null,
  !anon ? "VITE_SUPABASE_ANON_KEY" : null,
].filter(Boolean) as string[];

export const hasSupabaseEnv = missingSupabaseVars.length === 0;

const SUPABASE_ENV_ERROR =
  "Supabase environment variables are missing (VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY).";

type SupabaseError = { message: string };
type SupabaseResult = { data: null; error: SupabaseError };

class SupabaseStubQuery implements PromiseLike<SupabaseResult> {
  private message: string;

  constructor(message: string) {
    this.message = message;
  }

  select() {
    return this;
  }

  insert() {
    return this;
  }

  update() {
    return this;
  }

  upsert() {
    return this;
  }

  delete() {
    return this;
  }

  eq() {
    return this;
  }

  neq() {
    return this;
  }

  gt() {
    return this;
  }

  gte() {
    return this;
  }

  lt() {
    return this;
  }

  lte() {
    return this;
  }

  in() {
    return this;
  }

  order() {
    return this;
  }

  limit() {
    return this;
  }

  single() {
    return this;
  }

  maybeSingle() {
    return this;
  }

  throwOnError() {
    return this;
  }

  then<TResult1 = SupabaseResult, TResult2 = never>(
    onfulfilled?: ((value: SupabaseResult) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | null
  ): PromiseLike<TResult1 | TResult2> {
    const result: SupabaseResult = { data: null, error: { message: this.message } };
    return Promise.resolve(result).then(onfulfilled, onrejected);
  }
}

class SupabaseStubChannel {
  on() {
    return this;
  }

  subscribe() {
    return this;
  }
}

function createSupabaseStub() {
  return {
    from() {
      return new SupabaseStubQuery(SUPABASE_ENV_ERROR);
    },
    channel() {
      return new SupabaseStubChannel();
    },
    removeChannel() {
      return;
    },
  };
}

export const supabase = hasSupabaseEnv ? createClient(url, anon) : createSupabaseStub();
