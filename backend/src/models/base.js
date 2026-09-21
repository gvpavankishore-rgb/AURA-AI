import bcrypt from 'bcryptjs';
import getSupabase from '../config/supabase.js';
import { AppError } from '../middleware/errorHandler.js';

const snakeToCamel = (s) => s.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
const camelToSnake = (s) => s.replace(/([A-Z])/g, (c) => `_${c.toLowerCase()}`);

const GLOBAL_COLUMN_ALIASES = {
  id: '_id',
  user_id: 'user',
  conversation_id: 'conversation',
  created_at: 'createdAt',
  updated_at: 'updatedAt',
  expires_at: 'expiresAt',
};

const toDateValue = (v) => {
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'number') return new Date(v).toISOString();
  return v;
};

export class SupabaseModel {
  constructor(tableName, options = {}) {
    this.tableName = tableName;
    this.columnAliases = { ...GLOBAL_COLUMN_ALIASES, ...(options.columnAliases || {}) };
    this.fieldRenames = options.fieldRenames || {};
    this.allColumns = options.allColumns || [];
    this.excludeColumns = options.excludeColumns || [];
    this.setsUpdatedAt = options.setsUpdatedAt !== false;
    this.defaults = options.defaults || {};
    this.beforeWrite = options.beforeWrite || null;
  }

  col(field) {
    if (this.fieldRenames[field]) return this.fieldRenames[field];
    if (field === '_id') return 'id';
    if (field === 'user') return 'user_id';
    if (field === 'conversation') return 'conversation_id';
    return camelToSnake(field);
  }

  field(col) {
    if (this.columnAliases[col]) return this.columnAliases[col];
    return snakeToCamel(col);
  }

  defaultColumns() {
    return this.allColumns.filter((col) => !this.excludeColumns.includes(col));
  }

  resolveColumns(selectStr) {
    if (!selectStr || selectStr.trim() === '' || selectStr.trim() === '*') {
      return this.defaultColumns().join(',');
    }
    const keep = new Set(this.defaultColumns());
    const explicit = [];
    let hasExplicit = false;
    for (const token of selectStr.trim().split(/\s+/)) {
      if (token === '-__v') continue;
      if (token.startsWith('-')) {
        keep.delete(this.col(token.slice(1)));
        hasExplicit = true;
      } else if (token.startsWith('+')) {
        keep.add(this.col(token.slice(1)));
        hasExplicit = true;
      } else {
        explicit.push(this.col(token));
        hasExplicit = true;
      }
    }
    if (hasExplicit && explicit.length > 0) return explicit.join(',');
    return [...keep].join(',');
  }

  toRow(data) {
    const row = {};
    for (const [field, value] of Object.entries(data)) {
      if (value === undefined || field.startsWith('_') || typeof value === 'function') continue;
      row[this.col(field)] = value;
    }
    return row;
  }

  wrap(fields) {
    const doc = Object.create(this.instanceMethods());
    Object.assign(doc, fields);
    Object.defineProperty(doc, '__model', { value: this, enumerable: false });
    return doc;
  }

  instanceMethods() {
    return {
      save() {
        return this.__model.saveInstance(this);
      },
      deleteOne() {
        return this.__model.deleteInstance(this);
      },
      comparePassword(candidate) {
        return this.__model.comparePasswordInstance(this, candidate);
      },
    };
  }

  toDoc(row) {
    if (!row) return null;
    const fields = {};
    for (const [col, value] of Object.entries(row)) {
      if (col === '__v') continue;
      fields[this.field(col)] = value;
    }
    if ('id' in row) fields._id = row.id;
    return this.wrap(fields);
  }

  toDocs(rows) {
    return (rows || []).map((r) => this.toDoc(r));
  }

  applyFilters(query, filter) {
    for (const [field, value] of Object.entries(filter || {})) {
      const col = this.col(field);
      if (value !== null && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date)) {
        if (value.$regex !== undefined) {
          query = query.ilike(col, `%${value.$regex}%`);
        } else if (value.$gt !== undefined) {
          query = query.gt(col, toDateValue(value.$gt));
        } else if (value.$gte !== undefined) {
          query = query.gte(col, toDateValue(value.$gte));
        } else if (value.$lt !== undefined) {
          query = query.lt(col, toDateValue(value.$lt));
        } else if (value.$lte !== undefined) {
          query = query.lte(col, toDateValue(value.$lte));
        } else if (value.$in !== undefined) {
          query = query.in(col, value.$in);
        } else if (value.$ne !== undefined) {
          query = query.neq(col, value.$ne);
        } else {
          throw new AppError(`Unsupported filter operator in "${field}"`, 400);
        }
      } else if (value === null) {
        query = query.is(col, null);
      } else if (value === undefined) {
        continue;
      } else {
        query = query.eq(col, value);
      }
    }
    return query;
  }

  buildQuery({ filter, many }) {
    const model = this;
    const params = { filter, selectStr: '*', orders: [], limitN: null, rangeFrom: null, rangeTo: null };
    const chain = {
      select(selectStr) {
        params.selectStr = selectStr || '*';
        return chain;
      },
      sort(order) {
        for (const [field, dir] of Object.entries(order || {})) {
          params.orders.push({ col: model.col(field), ascending: Number(dir) >= 0 });
        }
        return chain;
      },
      order(field, opts = {}) {
        params.orders.push({ col: model.col(field), ascending: opts.ascending !== false });
        return chain;
      },
      limit(n) {
        params.limitN = n;
        return chain;
      },
      range(from, to) {
        params.rangeFrom = from;
        params.rangeTo = to;
        return chain;
      },
      then(resolve, reject) {
        return model.runFind({ ...params, many }).then(resolve, reject);
      },
      async execute() {
        return model.runFind({ ...params, many });
      },
    };
    return chain;
  }

  async runFind({ filter, selectStr, orders, limitN, rangeFrom, rangeTo, many }) {
    const sb = getSupabase();
    let query = sb.from(this.tableName).select(this.resolveColumns(selectStr));
    query = this.applyFilters(query, filter);
    for (const { col, ascending } of orders) {
      query = query.order(col, { ascending });
    }
    const hasRange = rangeFrom !== null && rangeTo !== null;
    const limit = !hasRange && (limitN || (!many ? 1 : null));
    if (limit) query = query.limit(limit);
    if (hasRange) query = query.range(rangeFrom, rangeTo);
    const { data, error } = await query;
    if (error) throw this.errorFrom(error);
    if (!many) return this.toDoc(Array.isArray(data) ? data[0] : data);
    return this.toDocs(Array.isArray(data) ? data : []);
  }

  async count(filter = {}) {
    const sb = getSupabase();
    const cols = this.defaultColumns();
    const probe = cols.length ? cols[0] : 'id';
    let query = sb.from(this.tableName).select(this.col(probe), { count: 'exact', head: true });
    query = this.applyFilters(query, filter);
    const { count, error } = await query;
    if (error) throw this.errorFrom(error);
    return count || 0;
  }

  find(filter = {}) {
    return this.buildQuery({ filter, many: true });
  }

  findOne(filter = {}) {
    return this.buildQuery({ filter, many: false });
  }

  findById(id) {
    return this.findOne({ _id: id });
  }

  async create(data) {
    const sb = getSupabase();
    const row = this.toRow({ ...this.defaults, ...data });
    if (this.beforeWrite) await this.beforeWrite(row);
    const { data: rows, error } = await sb.from(this.tableName).insert(row).select();
    if (error) throw this.errorFrom(error);
    return this.toDoc(Array.isArray(rows) ? rows[0] : rows);
  }

  async findOneAndUpdate(filter, updates, opts = {}) {
    const doc = await this.findOne(filter);
    if (!doc) {
      if (opts.upsert) {
        return this.create({ ...filter, ...updates });
      }
      return null;
    }
    Object.assign(doc, updates);
    return this.saveInstance(doc);
  }

  async findOneAndDelete(filter) {
    const doc = await this.findOne(filter);
    if (!doc) return null;
    await this.deleteInstance(doc);
    return doc;
  }

  async deleteOne(filter) {
    const doc = await this.findOne(filter);
    if (!doc) return null;
    return this.deleteInstance(doc);
  }

  async deleteMany(filter) {
    const sb = getSupabase();
    let query = sb.from(this.tableName).delete();
    query = this.applyFilters(query, filter);
    const { error } = await query;
    if (error) throw this.errorFrom(error);
  }

  dataFromDoc(doc) {
    const data = {};
    for (const [field, value] of Object.entries(doc)) {
      if (value === undefined || field.startsWith('_') || typeof value === 'function') continue;
      data[field] = value;
    }
    return data;
  }

  async saveInstance(doc) {
    if (!doc._id) {
      const created = await this.create(this.dataFromDoc(doc));
      for (const key of Object.keys(created)) doc[key] = created[key];
      if (created._id) doc._id = created._id;
      return doc;
    }
    const sb = getSupabase();
    const row = this.toRow(doc);
    delete row.id;
    if (this.setsUpdatedAt) row.updated_at = new Date().toISOString();
    if (this.beforeWrite) await this.beforeWrite(row);
    const { data, error } = await sb.from(this.tableName).update(row).eq('id', doc._id).select();
    if (error) throw this.errorFrom(error);
    const updated = this.toDoc(Array.isArray(data) ? data[0] : data);
    if (updated) {
      for (const key of Object.keys(updated)) doc[key] = updated[key];
      if (updated._id) doc._id = updated._id;
    }
    return doc;
  }

  async deleteInstance(doc) {
    if (!doc._id) return null;
    const sb = getSupabase();
    const { error } = await sb.from(this.tableName).delete().eq('id', doc._id);
    if (error) throw this.errorFrom(error);
    return doc;
  }

  async comparePasswordInstance(doc, candidate) {
    if (!doc || !doc.password) return false;
    return bcrypt.compare(candidate, doc.password);
  }

  errorFrom(error) {
    console.error(`[Supabase][${this.tableName}]`, error?.message || error);
    const msg = String(error?.message || '');
    if (error?.code === '23505' || /duplicate/i.test(msg)) {
      return new AppError('Duplicate value entered', 409);
    }
    if (error?.code === '23514' || /check constraint/i.test(msg)) {
      return new AppError('Invalid value', 400);
    }
    return new AppError(msg || 'Database operation failed', 500);
  }
}