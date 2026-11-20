-- Apply using: npx wrangler d1 execute maffyworld-orders --remote --file=./schema.sql
CREATE TABLE IF NOT EXISTS orders (
  pay_id TEXT PRIMARY KEY,
  product_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  nickname TEXT NOT NULL,
  quantity INTEGER NOT NULL CHECK(quantity BETWEEN 1 AND 50),
  amount INTEGER NOT NULL CHECK(amount > 0),
  command TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('awaiting-payment','test-paid','paid','claimed','delivered','manual-review')),
  transaction_id TEXT,
  created_at TEXT NOT NULL,
  claimed_at TEXT,
  delivered_at TEXT,
  delivery_note TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_transaction ON orders(transaction_id) WHERE transaction_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_orders_state_created ON orders(state,created_at);
CREATE TABLE IF NOT EXISTS agent_status (
  id INTEGER PRIMARY KEY CHECK (id=1),
  seen_at TEXT NOT NULL
);
