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

SF.googleOn = function () { return !!SF.PLATFORM.googleClientId; };

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
SF.action('signInGoogle', null, 'read', function (p) {
  if (!SF.googleOn()) return { ok: false, message: 'Google sign-in is not switched on yet.' };
  var device = String(p.device || '').slice(0, 60) || 'unknown';
  var who = SF.verifyGoogle(String(p.credential || ''));
  if (!who) return { ok: false, message: 'Google could not confirm who you are. Try again.' };

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
