/**
 * StallFlow — People
 * ===========================================================================
 * Google sign-in and the list of who may use a stall.
 *
 * The phone gets an ID token from Google and sends it here once. We ask
 * Google whether it is genuine and was issued for our client ID, look the
 * email up, and hand back the same kind of signed token the PINs produce,
 * with the email inside it. Every later request is checked against the Users
 * tab again (SF.dispatch), so switching someone off or changing their role
 * takes effect on their next tap, not when their token runs out.
 *
 * Platform admins (Platform.gs) are owner everywhere and are not in the tab.
 */

SF.SHEETS.users = ['Email', 'Name', 'Role', 'Active', 'AddedAt', 'AddedBy', 'LastSeen'];

SF.googleOn = function () {
  return !!SF.PLATFORM.googleClientId && SF.PLATFORM.admins.length > 0;
};

SF.cleanEmail = function (v) { return String(v || '').trim().toLowerCase(); };

SF.isAdmin = function (email) {
  email = SF.cleanEmail(email);
  return !!email && SF.PLATFORM.admins.map(SF.cleanEmail).indexOf(email) !== -1;
};

SF.findPerson = function (email) {
  email = SF.cleanEmail(email);
  var all = SF.rows('users');
  for (var i = 0; i < all.length; i++) {
    if (SF.cleanEmail(all[i].Email) === email) return all[i];
  }
  return null;
};

/** The role this person has right now, or null if they may not come in. */
SF.roleOf = function (email) {
  if (SF.isAdmin(email)) return 'owner';
  var p = SF.findPerson(email);
  if (!p || String(p.Active).toLowerCase() === 'no') return null;
  return SF.ROLES[String(p.Role)] ? String(p.Role) : null;
};

/** Ask Google whether an ID token is real and meant for us. */
SF.verifyGoogle = function (idToken) {
  var res = UrlFetchApp.fetch(
    'https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(idToken),
    { muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) return null;
  var t = SF.json(res.getContentText(), null);
  if (!t) return null;
  if (t.aud !== SF.PLATFORM.googleClientId) return null;
  if (t.iss !== 'accounts.google.com' && t.iss !== 'https://accounts.google.com') return null;
  if (String(t.email_verified) !== 'true') return null;
  if (Number(t.exp) * 1000 < Date.now()) return null;
  return { email: SF.cleanEmail(t.email), name: String(t.name || '') };
};

SF.action('authConfig', null, 'read', function () {
  return { google: SF.googleOn(), clientId: SF.PLATFORM.googleClientId };
});

// Public: the Google ID token is the credential.
/* ---- sign-in problems, for support ---------------------------------------
   A phone that cannot sign in reports what stage failed and a short code, so
   the owner can see the pattern (Health check). Never a token, an email or free
   text: stage and code come from fixed lists, and at most 40 reports an hour
   are kept, so nobody can fill the Audit tab by calling this. */
SF.AUTH_STAGES = ['load', 'render', 'init', 'network', 'refused', 'webview', 'offline', 'retry'];
SF.AUTH_CODES = ['blocked', 'timeout', 'no-button', 'init-threw', 'unreachable', 'token-not-accepted',
                 'embedded', 'offline', 'tapped'];
SF.AUTH_BROWSERS = ['chrome', 'chrome-android', 'chrome-ios', 'safari', 'safari-ios', 'firefox', 'samsung', 'webview', 'other'];

SF.authLogAllowed = function () {
  var hour = Utilities.formatDate(new Date(), SF.TZ, 'yyyyMMddHH');
  var cur = String(SF.get('authLogHour', '')).split(':');
  var n = cur[0] === hour ? Number(cur[1]) || 0 : 0;
  if (n >= 40) return false;
  SF.set('authLogHour', hour + ':' + (n + 1));
  return true;
};

SF.logAuthProblem = function (stage, code, browser, device) {
  if (!SF.authLogAllowed()) return false;
  SF.audit({ role: 'anon', device: String(device || '-').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 24) || '-' },
           'authError', stage, String(code) + (browser ? ' · ' + browser : ''), 'failed');
  return true;
};

// Public, like signIn: there is no token to check before somebody has signed in.
SF.action('authError', null, 'read', function (p) {
  var stage = String(p.stage || '');
  if (SF.AUTH_STAGES.indexOf(stage) === -1) return { ok: false };
  // Fixed lists only: anything else is filed as 'other', so free text can never get in.
  var code = String(p.code || '');
  if (SF.AUTH_CODES.indexOf(code) === -1) code = 'other';
  var browser = String(p.browser || '').replace(/-app$/, '');
  if (SF.AUTH_BROWSERS.indexOf(browser) === -1) browser = 'other';
  if (/-app$/.test(String(p.browser || ''))) browser += '-app';
  return { ok: true, logged: SF.logAuthProblem(stage, code, browser, p.device) };
});

SF.recentAuthProblems = function () {
  return SF.rows('audit').filter(function (r) { return String(r.Action) === 'authError'; })
    .slice(-8).reverse().map(function (r) {
      return { when: r.When instanceof Date ? Utilities.formatDate(r.When, SF.TZ, 'd MMM HH:mm') : '',
               stage: String(r.Target), detail: String(r.Detail) };
    });
};

SF.action('signInGoogle', null, 'read', function (p) {
  if (!SF.googleOn()) return { ok: false, message: 'Google sign-in is not switched on yet.' };
  var device = String(p.device || '').slice(0, 60) || 'unknown';
  var who = SF.verifyGoogle(String(p.credential || ''));
  if (!who) {
    // Google's check failed (an old or wrong token): note it, without the token.
    SF.logAuthProblem('refused', 'token-not-accepted', '', device);
    return { ok: false, message: 'Google could not confirm who you are. Tap Try again.' };
  }

  var role = SF.roleOf(who.email);
  if (!role) {
    SF.audit({ role: 'anon', device: device, user: who.email }, 'signIn', who.email,
             'not on the list', 'refused');
    return { ok: false, message: who.email + ' has not been added to this stall. ' +
                               'Ask the owner to add you under More › People.' };
  }

  var row = SF.findPerson(who.email);
  if (row) {
    SF.setCell('users', row._row, 'LastSeen', new Date());
    if (!row.Name && who.name) SF.setCell('users', row._row, 'Name', who.name);
  }
  SF.audit({ role: role, device: device, user: who.email }, 'signIn', who.email, 'google', 'ok');
  return { ok: true, token: SF.mintToken(role, device, who.email), role: role,
           user: who.email, name: who.name };
});

SF.action('people', 'people', 'read', function () {
  return {
    admins: SF.PLATFORM.admins.map(SF.cleanEmail),
    roles: Object.keys(SF.ROLES),
    people: SF.rows('users').map(function (r) {
      return {
        email: SF.cleanEmail(r.Email), name: String(r.Name || ''), role: String(r.Role),
        active: String(r.Active).toLowerCase() !== 'no',
        lastSeen: r.LastSeen instanceof Date
          ? Utilities.formatDate(r.LastSeen, SF.TZ, 'd MMM yyyy HH:mm') : ''
      };
    })
  };
});

SF.action('savePerson', 'people', 'write', function (p, ctx) {
  var email = SF.cleanEmail(p.email);
  var role = String(p.role || 'cashier');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return { ok: false, message: 'That does not look like an email address.' };
  }
  if (!SF.ROLES[role]) return { ok: false, message: 'Choose a role.' };
  if (SF.isAdmin(email)) {
    return { ok: false, message: email + ' is a StallFlow admin and is always owner.' };
  }
  if (ctx.user && SF.cleanEmail(ctx.user) === email) {
    return { ok: false, message: 'You cannot change your own access.' };
  }

  var active = p.active === false ? 'No' : 'Yes';
  var row = SF.findPerson(email);
  if (row) {
    SF.setCell('users', row._row, 'Role', role);
    SF.setCell('users', row._row, 'Active', active);
  } else {
    SF.append('users', {
      Email: email, Name: String(p.name || '').slice(0, 60), Role: role, Active: active,
      AddedAt: new Date(), AddedBy: ctx.user || ctx.role, LastSeen: ''
    });
  }
  SF.audit(ctx, 'savePerson', email, role + (active === 'No' ? ' (off)' : ''), 'ok');
  return { ok: true };
});

/**
 * Sheet menu: StallFlow › Check Google sign-in. Running it from the menu also
 * makes Google ask the account that clicked it for any permission the script
 * is missing, which is how the "contact Google" permission gets granted.
 */
function sfCheckGoogle() {
  var ui = SpreadsheetApp.getUi();
  var lines = [
    'Running as: ' + (Session.getEffectiveUser().getEmail() || 'unknown'),
    'Client ID set: ' + (SF.PLATFORM.googleClientId ? 'yes' : 'no'),
    'Admins: ' + (SF.PLATFORM.admins.join(', ') || 'none'),
    'Google sign-in on: ' + (SF.googleOn() ? 'yes' : 'no')
  ];
  try {
    var res = UrlFetchApp.fetch('https://oauth2.googleapis.com/tokeninfo?id_token=check',
                                { muteHttpExceptions: true });
    lines.push('Can reach Google: yes (' + res.getResponseCode() + ')');
  } catch (e) {
    lines.push('Can reach Google: NO — ' + e.message);
  }
  var errors = SF.rows('audit').filter(function (r) { return r.Outcome === 'error'; });
  if (errors.length) {
    var last = errors[errors.length - 1];
    lines.push('', 'Last error: ' + last.Action + ' — ' + last.Detail);
  }
  ui.alert('Google sign-in check', lines.join('\n'), ui.ButtonSet.OK);
}

/**
 * Same check, for the Apps Script editor (Run ▸ sfGrantGoogle). The editor
 * picks the account from its own address, so this works even when the browser
 * has several Google accounts signed in and the sheet menu runs as the wrong
 * one. The result shows in the editor's execution log.
 */
function sfGrantGoogle() {
  var res = UrlFetchApp.fetch('https://oauth2.googleapis.com/tokeninfo?id_token=check',
                              { muteHttpExceptions: true });
  Logger.log('Running as ' + Session.getEffectiveUser().getEmail() +
             '. Google answered ' + res.getResponseCode() + ', so the permission is in place.');
}
