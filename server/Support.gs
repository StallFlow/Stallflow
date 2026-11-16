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

SF.assistantOn = function () { return !!SF.get('assistantKeyHash', ''); };   // = SF.connOn(SF.CONNECTORS.claude)

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

/* =========================================================================
   CHATGPT AS A DESIGN CONNECTOR
   -------------------------------------------------------------------------
   A second, separate connector for making artwork: posts, posters, labels,
   price sheets and the order page's look. It has its own key (made by the
   same StallFlow administrator, in the same Settings card style) and its own
   short list of tools. It reads only what a designer needs: the shop's name,
   colours and label look, the products that are switched on with prices and
   stock, and the public order links. It never sees cost prices, money,
   orders, customers, bank details, PINs or people.

   The one change it can make is a design note (a short brief for the owner,
   shown in Settings): harmless, and a way to find out whether ChatGPT's plan
   allows a connector to change anything at all. Every call is audited as
   "ChatGPT (design connector)". ChatGPT reaches it through the sign-in relay
   in tools/chatgpt/, which checks the person's Google account first.
   ========================================================================= */

SF.DESIGN_NOTE_MAX = 500;

/** The public address of this stall's site, e.g. https://stallflow.github.io/Stallflow/duxies/ */
SF.cleanSite = function (u) {
  u = String(u == null ? '' : u).trim().split('?')[0].split('#')[0];
  if (!/^https:\/\/[A-Za-z0-9.-]+(\/[A-Za-z0-9._~\-\/]*)?$/.test(u) || u.length > 200) return '';
  u = u.replace(/\/app\/?$/, '/').replace(/index\.html$/, '');
  return /\/$/.test(u) ? u : u + '/';
};

function sfDesignProduct(p) {
  // Never the cost price or the margin: those are the owner's, not a designer's.
  return { id: p.id, name: p.name, variant: p.variant, category: p.category, type: p.type,
           unit: p.unit, price: p.price, available: p.available, onHand: p.onHand, on: p.active !== false };
}

SF.designLinks = function () {
  var site = String(SF.get('designSite', ''));
  var link = function (id) { return site ? site + '?m=' + encodeURIComponent(id) : ''; };
  return {
    site: site,
    orderPage: site,
    betweenMarkets: link('home'),
    markets: SF.orderableMarkets().map(function (m) {
      return { name: m.name, date: m.date || '', where: m.location || '', link: link(m.id) };
    })
  };
};

SF.designBrand = function (withLogo) {
  var pr = SF.profile(), look = SF.labelLook();
  return {
    name: pr.name, tagline: pr.tagline || '', ownerName: pr.ownerName || '', whatsapp: pr.whatsapp || '',
    colours: { main: pr.colour, text: pr.ink, background: pr.paper },
    words: pr.vocab || {},
    labels: { style: look.style, contactLines: look.contact ? look.contact.split('\n') : [],
              showsPrice: look.price, hasLogo: !!look.logo, logo: withLogo ? look.logo : undefined },
    links: SF.designLinks(),
    lastDesignNote: { text: String(SF.get('designNote', '')), at: String(SF.get('designNoteAt', '')) }
  };
};

SF.DESIGN_TOOLS = {
  brand_kit: {
    write: false, title: 'Brand kit',
    description: 'Read-only. The shop\'s name, tagline, colours (hex), label look and the public order page links. ' +
      'Start here before designing anything. Set include_logo to true to get the label logo as a PNG data URL.',
    props: { include_logo: { type: 'boolean', description: 'Also return the black-and-white label logo (a PNG data URL).' } },
    need: [],
    run: function (a) { return { ok: true, brand: SF.designBrand(a.include_logo === true) }; }
  },
  product_list: {
    write: false, title: 'Products and prices',
    description: 'Read-only. Every product that is switched on: name, size (variant), category, price in rand, ' +
      'units on hand and how many can be ordered. Use it for price lists, posts, labels and posters. ' +
      'Set include_hidden to true to also list products that are switched off.',
    props: { include_hidden: { type: 'boolean' } },
    need: [],
    run: function (a) {
      return { ok: true, currency: 'ZAR', products: SF.products({ all: a.include_hidden === true }).map(sfDesignProduct) };
    }
  },
  order_pages: {
    write: false, title: 'Order pages',
    description: 'Read-only. The public order page links: one per upcoming market (name, date, where) and one ' +
      'for orders between markets. Put these on posters and QR codes.',
    props: {}, need: [],
    run: function () { return { ok: true, links: SF.designLinks() }; }
  },
  search: {
    write: false, title: 'Search',
    description: 'Read-only. Search the shop\'s products (and its brand kit) by words such as a flavour, size or ' +
      'category. Returns ids to pass to fetch.',
    props: { query: { type: 'string', description: 'Words to look for, for example "strawberry 125 ml"' } },
    need: ['query'],
    run: function (a) {
      var words = String(a.query || '').toLowerCase().split(/\s+/).filter(Boolean).slice(0, 8);
      var site = String(SF.get('designSite', ''));
      var results = SF.products({}).filter(function (p) {
        var hay = (p.name + ' ' + p.variant + ' ' + p.category).toLowerCase();
        return words.every(function (w) { return hay.indexOf(w) !== -1; });
      }).slice(0, 25).map(function (p) {
        return { id: p.id, title: p.name + (p.variant ? ' (' + p.variant + ')' : '') + ' — R' + p.price, url: site };
      });
      if (!words.length || /brand|colou?r|logo|label|shop/.test(words.join(' '))) {
        results.unshift({ id: 'brand', title: 'Brand kit: name, colours, labels, links', url: site });
      }
      return { ok: true, results: results };
    }
  },
  fetch: {
    write: false, title: 'Fetch',
    description: 'Read-only. Fetch one result from search by its id: a product id, or "brand" for the brand kit.',
    props: { id: { type: 'string' } },
    need: ['id'],
    run: function (a) {
      var site = String(SF.get('designSite', ''));
      if (String(a.id) === 'brand') {
        return { ok: true, id: 'brand', title: 'Brand kit', url: site, text: JSON.stringify(SF.designBrand(false)) };
      }
      var p = SF.byId(SF.products({}), a.id);
      if (!p) return { ok: false, message: 'No product with id ' + String(a.id).slice(0, 20) + ' is switched on.' };
      var d = sfDesignProduct(p);
      return { ok: true, id: d.id, title: d.name + (d.variant ? ' (' + d.variant + ')' : ''), url: site,
               text: JSON.stringify(d), metadata: { category: d.category, price: d.price } };
    }
  },
  save_design_note: {
    write: true, title: 'Save a design note',
    description: 'Leave one short design note for the shop owner (at most 500 characters), for example which ' +
      'poster was made and where it is. It replaces the previous note and is shown in the app\'s Settings. ' +
      'It changes nothing else.',
    props: { note: { type: 'string', description: 'The note, plain words' } },
    need: ['note'],
    run: function (a) {
      var note = String(a.note).replace(/[\u0000-\u0009\u000B-\u001F]/g, ' ').trim().slice(0, SF.DESIGN_NOTE_MAX);
      if (!note) return { ok: false, message: 'The note is empty.' };
      SF.set('designNote', note);
      SF.set('designNoteAt', new Date().toISOString());
      return { ok: true, saved: note.length + ' characters' };
    }
  }
};

/* ---- one set of machinery for both connectors ---- */

SF.CONNECTORS = {
  claude: {
    id: 'claude', prefix: 'assistant', who: 'Claude', actor: 'Claude (connector)',
    tools: function () { return SF.ASSISTANT_TOOLS; }, perHour: function () { return SF.ASSISTANT_PER_HOUR; },
    instructions: 'StallFlow is a market stall\'s till and stock. Call stallflow_stock first to find product ids. ' +
      'Every change you make is recorded as Claude. Do only what the owner asked, and tell her what you changed.'
  },
  chatgpt: {
    id: 'chatgpt', prefix: 'design', who: 'ChatGPT', actor: 'ChatGPT (design connector)',
    tools: function () { return SF.DESIGN_TOOLS; }, perHour: function () { return SF.ASSISTANT_PER_HOUR; },
    instructions: 'StallFlow is a small market stall\'s shop system. You are helping with artwork: posts, ' +
      'posters, labels, price lists and the look of the order page. Call brand_kit first for the name, colours ' +
      'and links, then product_list for products and prices (South African rand, R). Use only real prices and ' +
      'links from these tools. You cannot see or change money, orders or customers.'
  }
};

SF.connOn = function (c) { return !!SF.get(c.prefix + 'KeyHash', ''); };

SF.connKeyOk = function (c, key) {
  var want = String(SF.get(c.prefix + 'KeyHash', ''));
  if (!want || !key) return false;
  var got = SF.hash(c.prefix + ':' + key), diff = got.length ^ want.length;
  for (var i = 0; i < got.length && i < want.length; i++) diff |= got.charCodeAt(i) ^ want.charCodeAt(i);
  return diff === 0;
};

SF.connAllowed = function (c) {
  var hour = Utilities.formatDate(new Date(), SF.TZ, 'yyyyMMddHH');
  var cur = String(SF.get(c.prefix + 'Hour', '')).split(':');
  var n = cur[0] === hour ? Number(cur[1]) || 0 : 0;
  if (n >= c.perHour()) return false;
  SF.set(c.prefix + 'Hour', hour + ':' + (n + 1));
  return true;
};

SF.connCall = function (c, name, args) {
  var tools = c.tools(), tool = Object.prototype.hasOwnProperty.call(tools, name) ? tools[name] : null;
  if (!tool) return { ok: false, message: 'There is no tool called ' + String(name).slice(0, 40) + '.' };
  args = args && typeof args === 'object' ? args : {};
  for (var i = 0; i < tool.need.length; i++) {
    if (args[tool.need[i]] === undefined || args[tool.need[i]] === null || args[tool.need[i]] === '') {
      return { ok: false, message: 'Missing: ' + tool.need[i] };
    }
  }
  var ctx = { role: 'assistant', user: c.actor, device: 'connector', action: name };
  if (!tool.write) return tool.run(args);
  var asked = String(args.reason || args.name || args.product_id || args.note || '').slice(0, 120);
  var go = function () {
    var res = tool.run(args);
    SF.audit(ctx, name, args.product_id || args.name || '',
             JSON.stringify({ asked: asked, qty: args.qty, price: args.price, on: args.on }).slice(0, 250) +
             (res && res.ok === false ? ' → ' + res.message : ''),
             res && res.ok === false ? 'refused' : 'ok');
    return res;
  };
  // request_id makes a repeat of the same request a no-op rather than a second change.
  return args.request_id ? SF.once('mcp:' + c.id + ':' + String(args.request_id).slice(0, 60), name, ctx, go) : SF.lock(go);
};

SF.connTools = function (c) {
  var tools = c.tools();
  return Object.keys(tools).map(function (name) {
    var t = tools[name], props = {};
    Object.keys(t.props).forEach(function (k) { props[k] = t.props[k]; });
    if (t.write) props.request_id = { type: 'string', description: 'Optional: a short unique id for this request, so sending it twice changes things only once.' };
    return { name: name, title: t.title || name, description: t.description,
             inputSchema: { type: 'object', properties: props, required: t.need },
             annotations: { title: t.title || name, readOnlyHint: !t.write, destructiveHint: false,
                            idempotentHint: !t.write, openWorldHint: false } };
  });
};

SF.connOne = function (c, msg) {
  msg = msg && typeof msg === 'object' ? msg : {};
  var id = msg.id, method = String(msg.method || '');
  var ok = function (result) { return { jsonrpc: '2.0', id: id, result: result }; };
  var bad = function (code, message) { return { jsonrpc: '2.0', id: id, error: { code: code, message: message } }; };
  if (id === undefined || id === null) return null;                 // a notification: nothing to answer
  if (method === 'initialize') {
    var pv = msg.params && msg.params.protocolVersion;
    return ok({ protocolVersion: pv || '2025-03-26', capabilities: { tools: {} },
                serverInfo: { name: 'StallFlow', version: SF.VERSION }, instructions: c.instructions });
  }
  if (method === 'ping') return ok({});
  if (method === 'tools/list') return ok({ tools: SF.connTools(c) });
  if (method === 'tools/call') {
    var p = msg.params || {};
    if (!SF.connAllowed(c)) return ok({ isError: true, content: [{ type: 'text', text: 'Too many requests this hour. Try again later.' }] });
    var res = SF.connCall(c, String(p.name || ''), p.arguments);
    SF.set(c.prefix + 'LastUsed', new Date().toISOString());
    return ok({ isError: res && res.ok === false, content: [{ type: 'text', text: JSON.stringify(res) }] });
  }
  return bad(-32601, 'Method not found: ' + method);
};

/** Entry point from doPost/doGet. Returns {reply} (null for "no answer") or {error}. */
SF.connServe = function (c, key, body) {
  if (!SF.connOn(c) || !SF.connKeyOk(c, key)) {
    return { error: { code: -32001, message: 'This connector key is not valid. Ask the owner for a new one.' } };
  }
  var out;
  if (Array.isArray(body)) out = body.map(function (m) { return SF.connOne(c, m); }).filter(function (x) { return x; });
  else out = SF.connOne(c, body || {});
  return { reply: out };
};

/* ---- the Claude names, kept as they were ---- */
SF.assistantCall = function (name, args) { return SF.connCall(SF.CONNECTORS.claude, name, args); };
SF.mcpTools = function () { return SF.connTools(SF.CONNECTORS.claude); };
SF.mcpOne = function (msg) { return SF.connOne(SF.CONNECTORS.claude, msg); };
SF.mcp = function (key, body) { return SF.connServe(SF.CONNECTORS.claude, key, body); };
/** The ChatGPT design connector: the address carries the key (?design=KEY). */
SF.mcpDesign = function (key, body) { return SF.connServe(SF.CONNECTORS.chatgpt, key, body); };

/* ---- the administrator's side for ChatGPT: make the key, see it, switch it off ---- */

SF.action('designKey', 'people', 'write', function (p, ctx) {
  if (!SF.assistantAdmin(ctx)) return SF.assistantRefused;
  var site = SF.cleanSite(p.site);
  var key = (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '');
  SF.set('designKeyHash', SF.hash('design:' + key));
  SF.set('designSince', SF.today());
  if (site) SF.set('designSite', site);
  SF.audit(ctx, 'designKey', 'ChatGPT', 'a new design connector key was made; any older one stopped working', 'ok');
  return { ok: true, key: key };
});

SF.action('designOff', 'people', 'write', function (p, ctx) {
  if (!SF.assistantAdmin(ctx)) return SF.assistantRefused;
  SF.set('designKeyHash', '');
  SF.audit(ctx, 'designOff', 'ChatGPT', 'the design connector was switched off', 'ok');
  return { ok: true };
});

SF.action('designStatus', 'people', 'read', function (p, ctx) {
  if (!SF.assistantAdmin(ctx)) return SF.assistantRefused;
  return { on: SF.connOn(SF.CONNECTORS.chatgpt), since: String(SF.get('designSince', '')),
           lastUsed: String(SF.get('designLastUsed', '')), site: String(SF.get('designSite', '')),
           note: String(SF.get('designNote', '')), noteAt: String(SF.get('designNoteAt', '')) };
});
