import fs from "node:fs";
import path from "node:path";

/** Tiny JSON-file store. Pass dbPath = null for an in-memory store (used by tests). */
export class Store {
  constructor(dbPath) {
    this.dbPath = dbPath;
    this.data = { invoices: {}, chain: null, intents: { deposits: {} }, meta: { createdAt: Date.now() } };
    if (dbPath && fs.existsSync(dbPath)) {
      try {
        this.data = { ...this.data, ...JSON.parse(fs.readFileSync(dbPath, "utf8")) };
      } catch (e) {
        console.error(`Could not read ${dbPath} (${e.message}); starting empty.`);
      }
    }
  }

  save() {
    if (!this.dbPath) return;
    fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
    const tmp = this.dbPath + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.dbPath); // atomic replace
  }

  getInvoice(id) {
    return this.data.invoices[id] || null;
  }
  putInvoice(inv) {
    this.data.invoices[inv.id] = inv;
    this.save();
    return inv;
  }
  listByOwner(owner) {
    return Object.values(this.data.invoices)
      .filter((i) => i.owner === owner)
      .sort((a, b) => b.created_at - a.created_at);
  }
}
