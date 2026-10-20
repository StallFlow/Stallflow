/**
 * StallFlow — Platform
 * ===========================================================================
 * Settings that are the same for every stall, because they belong to
 * StallFlow the company rather than to any one stall.
 *
 *   googleClientId   the OAuth client ID from the StallFlow Google Cloud
 *                    project. While it is blank, staff sign in with PINs.
 *                    Once it is set, Google is the only way in.
 *   admins           Google accounts that are owner on every stall and can
 *                    never be removed or demoted from inside a stall.
 *
 * Google sign-in only switches on when both are filled in. A client ID with
 * no admins would turn PINs off with nobody able to sign in.
 */

SF.PLATFORM = {
  googleClientId: '385335470126-0c11amdmojlqns2tdhv9qfch6227ti7c.apps.googleusercontent.com',
  admins: []
};
