import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

export function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    const st = statSync(abs);
    if (st.isDirectory()) yield* walk(abs);
    else if (st.isFile()) yield abs;
  }
}
