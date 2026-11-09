/* =========================================================================
   CLAUDE AS A CONNECTOR
   -------------------------------------------------------------------------
   The owner makes a key in Settings. Claude (in the Claude app, as a custom
   connector) calls this stall's address with that key and can do a short,
   fixed list of jobs: read stock, add a product, change a price, add or take
   off stock, switch a product off or on, and read problem reports.

   It can never touch money, orders, markets, PINs or who has access, and a
   product is only ever switched off, never deleted. Every call is written to
   the audit trail as "Claude (connector)" with what was asked. The key is
   kept only as a hash and is shown once; switching it off ends access at once.
   ========================================================================= */

SF.ASSISTANT_PER_HOUR = 120;
SF.ASSISTANT_MAX_QTY = 500;

SF.assistantOn = function () { return !!SF.get('assistantKeyHash', ''); };

SF.assistantKeyOk = function (key) {
  var want = String(SF.get('assistantKeyHash', ''));
  if (!want || !key) return false;
  var got = SF.hash('assistant:' + key), diff = got.length ^ want.length;
  for (var i = 0; i < got.length && i < want.length; i++) diff |= got.charCodeAt(i) ^ want.charCodeAt(i);
  return diff === 0;
};

SF.assistantAllowed = function () {
  var hour = Utilities.formatDate(new Date(), SF.TZ, 'yyyyMMddHH');
  var cur = String(SF.get('assistantHour', '')).split(':');
  var n = cur[0] === hour ? Number(cur[1]) || 0 : 0;
  if (n >= SF.ASSISTANT_PER_HOUR) return false;
  SF.set('assistantHour', hour + ':' + (n + 1));
  return true;
};

/* ---- the owner's side: make the key, see it is on, switch it off ---- */

/**
 * Who may set up, see or switch off the connector: the StallFlow platform administrator who
 * built the stall (SF.PLATFORM.admins), nobody else. The stall's own owner, managers and
 * cashiers never see it. (Platform admins are owner on every stall; a stall's own owner is
 * not an admin.) Without Google sign-in nobody is an admin, so it cannot be set up in PIN mode.
 */
SF.assistantAdmin = function (ctx) { return !!ctx && SF.isAdmin(ctx.user); };
SF.assistantRefused = { ok: false, code: 'forbidden', message: 'Only the StallFlow administrator can do this.' };

SF.action('assistantKey', 'people', 'write', function (p, ctx) {
  if (!SF.assistantAdmin(ctx)) return SF.assistantRefused;
  var key = (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '');
  SF.set('assistantKeyHash', SF.hash('assistant:' + key));
  SF.set('assistantSince', SF.today());
  SF.audit(ctx, 'assistantKey', 'Claude', 'a new connector key was made; any older one stopped working', 'ok');
  // Shown once. Only its hash is kept.
  return { ok: true, key: key };
});

SF.action('assistantOff', 'people', 'write', function (p, ctx) {
  if (!SF.assistantAdmin(ctx)) return SF.assistantRefused;
  SF.set('assistantKeyHash', '');
  SF.audit(ctx, 'assistantOff', 'Claude', 'the connector was switched off', 'ok');
  return { ok: true };
});

SF.action('assistantStatus', 'people', 'read', function (p, ctx) {
  if (!SF.assistantAdmin(ctx)) return SF.assistantRefused;
  return { on: SF.assistantOn(), since: String(SF.get('assistantSince', '')),
           lastUsed: String(SF.get('assistantLastUsed', '')) };
});

/* ---- the tools Claude is given: each one is a fixed, named job ---- */

function sfAssistantProduct(p) {
  return { id: p.id, name: p.name, variant: p.variant, category: p.category, type: p.type,
           unit: p.unit, price: p.price, onHand: p.onHand, active: p.active !== false };
}

SF.ASSISTANT_TOOLS = {
  stallflow_stock: {
    write: false,
    description: 'List every product with its id, category, price, units on hand and whether it is switched on. Use this first, to find the right product id before changing anything.',
    props: {}, need: [],
    run: function () {
      var all = SF.products({ all: true });
      return { ok: true, products: all.map(sfAssistantProduct) };
    }
  },
  stallflow_add_product: {
    write: true,
    description: 'Add a new product to the till and the order page, optionally with the stock she has now. Check stallflow_stock first so you do not add one that already exists, and use an existing category name where one fits.',
    props: {
      name: { type: 'string', description: 'Product name, for example "Lizard resin ornament"' },
      category: { type: 'string', description: 'Category such as Resin, Jams, Crochet. Use one that already exists if it fits.' },
      price: { type: 'number', description: 'Selling price in rand' },
      qty: { type: 'number', description: 'How many she has right now (0 if none)' },
      variant: { type: 'string', description: 'Optional size or variant, for example 352 ml' }
    },
    need: ['name', 'price'],
    run: function (a) {
      return SF.CORE_ACTIONS.saveProduct.fn({ name: a.name, category: a.category || 'Other', price: a.price,
        qty: a.qty || 0, variant: a.variant || '', type: 'stocked', unit: 'each' }, {});
    }
  },
  stallflow_set_price: {
    write: true,
    description: 'Change one product\'s selling price.',
    props: { product_id: { type: 'string' }, price: { type: 'number', description: 'New price in rand' } },
    need: ['product_id', 'price'],
    run: function (a) { return SF.CORE_ACTIONS.setPrice.fn({ productId: a.product_id, price: a.price }, {}); }
  },
  stallflow_adjust_stock: {
    write: true,
    description: 'Add stock (positive number) or take stock off (negative number) for one product, with a short reason such as "delivery" or "damaged". Counts only the units; it does not touch sales or money.',
    props: { product_id: { type: 'string' },
             qty: { type: 'number', description: 'Units to add (positive) or remove (negative), at most 500 either way' },
             reason: { type: 'string' } },
    need: ['product_id', 'qty'],
    run: function (a) {
      if (Math.abs(SF.num(a.qty)) > SF.ASSISTANT_MAX_QTY) {
        return { ok: false, message: 'That is more than ' + SF.ASSISTANT_MAX_QTY + ' at once. Ask the owner to do it in the app.' };
      }
      return SF.CORE_ACTIONS.adjustStock.fn({ productId: a.product_id, qty: a.qty, reason: a.reason || 'via Claude' }, { role: 'assistant', user: 'Claude (connector)' });
    }
  },
  stallflow_switch_product: {
    write: true,
    description: 'Switch a product off (hide it from the till and order page; nothing is deleted) or back on.',
    props: { product_id: { type: 'string' }, on: { type: 'boolean', description: 'true to show it, false to hide it' } },
    need: ['product_id', 'on'],
    run: function (a) { return SF.CORE_ACTIONS.setActive.fn({ productId: a.product_id, active: a.on === true }, {}); }
  },
  stallflow_stocktake: {
    write: false,
    description: 'Read-only: the latest stocktake (open or finished): its status, which locations are done, and for every counted product what was counted against what the app shows now. Use it to find out why stock does not match a count. It changes nothing.',
    props: {}, need: [],
    run: function () {
      var rows = SF.rows('stockcounts'), row = SF.openCount() || rows[rows.length - 1];
      if (!row) return { ok: true, status: 'none', message: 'No stocktake has been started.' };
      var review = SF.countReview(row), prog = SF.countProgress(String(row.CountId));
      var now = {};
      SF.products({ all: true }).forEach(function (p) { now[p.id] = p.onHand; });
      var counted = review.filter(function (r) { return r.counted !== null; });
      return { ok: true, id: String(row.CountId), status: String(row.Status),
        startedAt: row.StartedAt instanceof Date ? row.StartedAt.toISOString() : String(row.StartedAt || ''),
        closedAt: row.ClosedAt instanceof Date ? row.ClosedAt.toISOString() : String(row.ClosedAt || ''),
        result: SF.json(row.Result, {}),
        locations: Object.keys(prog).map(function (n) { return { name: n, submitted: !!prog[n].sub, by: prog[n].by || '' }; }),
        totals: { counted: Math.round(counted.reduce(function (a, r) { return a + r.counted; }, 0) * 1000) / 1000,
                  appNow: Math.round(Object.keys(now).reduce(function (a, k) { return a + now[k]; }, 0) * 1000) / 1000 },
        lines: counted.map(function (r) {
          return { id: r.id, name: r.name, variant: r.variant, expectedAtStart: r.startExpected,
                   appHadWhenCounted: r.expected, counted: r.counted, appNow: now[r.id],
                   soldSinceCount: r.soldSince };
        }),
        notCountedButInStock: review.filter(function (r) { return r.counted === null && r.startExpected; })
          .map(function (r) { return { id: r.id, name: r.name, variant: r.variant, expectedAtStart: r.startExpected, appNow: now[r.id] }; }) };
    }
  },
  stallflow_problems: {
    write: false,
    description: 'Support: the latest problems reported from the app, any items the checks flag, and recent Google sign-in problems.',
    props: {}, need: [],
    run: function () {
      var rows = SF.rows('issues').slice(-15).reverse().map(function (r) {
        return { id: r.IssueId, when: r.When instanceof Date ? r.When.toISOString() : String(r.When),
                 screen: r.Screen, message: r.Message, status: r.Status, link: r.Link };
      });
      var h = SF.CORE_ACTIONS.health.fn({}, {});
      return { ok: true, reports: rows, checks: h.problems || [], signInProblems: h.signInProblems || [] };
    }
  }
};

SF.assistantCall = function (name, args) {
  var tool = SF.ASSISTANT_TOOLS[name];
  if (!tool) return { ok: false, message: 'There is no tool called ' + name + '.' };
  args = args && typeof args === 'object' ? args : {};
  for (var i = 0; i < tool.need.length; i++) {
    if (args[tool.need[i]] === undefined || args[tool.need[i]] === null || args[tool.need[i]] === '') {
      return { ok: false, message: 'Missing: ' + tool.need[i] };
    }
  }
  var ctx = { role: 'assistant', user: 'Claude (connector)', device: 'connector', action: name };
  if (!tool.write) return tool.run(args);
  var asked = String(args.reason || args.name || args.product_id || '').slice(0, 120);
  var go = function () {
    var res = tool.run(args);
    SF.audit(ctx, name, args.product_id || args.name || '',
             JSON.stringify({ asked: asked, qty: args.qty, price: args.price, on: args.on }).slice(0, 250) +
             (res && res.ok === false ? ' → ' + res.message : ''),
             res && res.ok === false ? 'refused' : 'ok');
    return res;
  };
  // request_id makes a repeat of the same request a no-op rather than a second change.
  return args.request_id ? SF.once('mcp:' + String(args.request_id).slice(0, 60), name, ctx, go) : SF.lock(go);
};

/* ---- the connector protocol (MCP over HTTP, JSON): what the Claude app speaks ---- */

SF.mcpTools = function () {
  return Object.keys(SF.ASSISTANT_TOOLS).map(function (name) {
    var t = SF.ASSISTANT_TOOLS[name], props = {};
    Object.keys(t.props).forEach(function (k) { props[k] = t.props[k]; });
    if (t.write) props.request_id = { type: 'string', description: 'Optional: a short unique id for this request, so sending it twice changes things only once.' };
    return { name: name, description: t.description,
             inputSchema: { type: 'object', properties: props, required: t.need } };
  });
};

SF.mcpOne = function (msg) {
  var id = msg.id, method = String(msg.method || '');
  var ok = function (result) { return { jsonrpc: '2.0', id: id, result: result }; };
  var bad = function (code, message) { return { jsonrpc: '2.0', id: id, error: { code: code, message: message } }; };
  if (id === undefined || id === null) return null;                 // a notification: nothing to answer
  if (method === 'initialize') {
    var pv = msg.params && msg.params.protocolVersion;
    return ok({ protocolVersion: pv || '2025-03-26', capabilities: { tools: {} },
                serverInfo: { name: 'StallFlow', version: SF.VERSION },
                instructions: 'StallFlow is a market stall\'s till and stock. Call stallflow_stock first to find product ids. ' +
                  'Every change you make is recorded as Claude. Do only what the owner asked, and tell her what you changed.' });
  }
  if (method === 'ping') return ok({});
  if (method === 'tools/list') return ok({ tools: SF.mcpTools() });
  if (method === 'tools/call') {
    var p = msg.params || {};
    if (!SF.assistantAllowed()) return ok({ isError: true, content: [{ type: 'text', text: 'Too many requests this hour. Try again later.' }] });
    var res = SF.assistantCall(String(p.name || ''), p.arguments);
    SF.set('assistantLastUsed', new Date().toISOString());
    return ok({ isError: res && res.ok === false, content: [{ type: 'text', text: JSON.stringify(res) }] });
  }
  return bad(-32601, 'Method not found: ' + method);
};

/** Entry point from doPost/doGet: the key is in the address (?mcp=KEY). Returns text, or null for "no answer". */
SF.mcp = function (key, body) {
  if (!SF.assistantOn() || !SF.assistantKeyOk(key)) {
    return { error: { code: -32001, message: 'This connector key is not valid. Ask the owner for a new one.' } };
  }
  var out;
  if (Array.isArray(body)) out = body.map(SF.mcpOne).filter(function (x) { return x; });
  else out = SF.mcpOne(body || {});
  return { reply: out };
};
