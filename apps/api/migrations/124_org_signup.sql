-- Organisation self-service sign-up (slice S6a; owner decisions D2 and D8 of 2026-11-26).
-- A stranger may ask for an organisation on the platform. Nothing exists in the identity plane until a super administrator
-- approves the request, so the public route can never create an account, an organisation or a school by itself:
--
--   1. POST /v1/signup/organizations (public) stores a REQUEST (organization_signups) and e-mails a confirmation link.
--   2. POST /v1/signup/organizations/verify (public) proves the person owns the address; the request waits for review.
--   3. A super administrator approves or rejects it (platform console). Approving creates the organisation (active), the
--      administrator's account (status 'invited', unusable credential, as the first platform administrator is made in
--      scripts/bootstrap-admin.mjs) and their org_admin membership, and issues a password-setup link (a password_reset
--      token, completed through the existing /v1/auth/password-reset/complete) that only the confirmed mailbox receives.
--
-- No password is collected at sign-up, so a request typed by someone else cannot pre-set the credential of a mailbox they do
-- not own. An address that already has an account cannot be approved (the reviewer sees a 409): an e-mailed link must never
-- attach an organisation to somebody else's login.
--
--   * organization_signups holds personal data (a name, an address, a phone) and has no tenant. Owner-only, as
--     platform_incidents (121) and account_tokens (072): forced row-level security whose only policy is for the table owner,
--     and no privilege for figbloom_app or figbloom_worker. The runtime role reaches it only through the SECURITY DEFINER
--     functions below. The confirmation token is random (32 bytes); only its SHA-256 is stored, and it is cleared once used.
--   * The two public functions take no acting user (there is none); the four platform functions re-check that the acting user
--     (app.user_id) is a super administrator and raise 42501 otherwise.
--   * Every outcome writes its security_audit_events row in the same transaction. The detail carries ids and the kind,
--     never a name, an address, a phone number or the reviewer's reason.
-- Forward-only.

INSERT INTO permissions (code, description) VALUES
  ('platform.org_signups.manage', 'Platform: list, approve and reject organisation sign-up requests and re-issue the first administrator''s password link (personal data, no school data)')
ON CONFLICT (code) DO NOTHING;

INSERT INTO role_permissions (role, permission_code) VALUES
  ('super_admin', 'platform.org_signups.manage')
ON CONFLICT (role, permission_code) DO NOTHING;

CREATE TABLE public.organization_signups (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name              text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 2 AND 160 AND name !~ '[[:cntrl:]]'),
  kind              text NOT NULL CHECK (kind IN ('government', 'county', 'constituency', 'group_owner')),
  county            text CHECK (county IS NULL OR (char_length(btrim(county)) BETWEEN 1 AND 80 AND county !~ '[[:cntrl:]]')),
  contact_phone     text CHECK (contact_phone IS NULL OR (char_length(contact_phone) BETWEEN 6 AND 40 AND contact_phone ~ '^[0-9+()\s-]+$')),
  admin_full_name   text NOT NULL CHECK (char_length(btrim(admin_full_name)) BETWEEN 1 AND 160 AND admin_full_name !~ '[[:cntrl:]]'),
  admin_email       text NOT NULL CHECK (admin_email = lower(admin_email) AND char_length(admin_email) <= 254 AND admin_email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  status            text NOT NULL DEFAULT 'pending_email' CHECK (status IN ('pending_email', 'pending_review', 'approved', 'rejected', 'expired')),
  verify_token_hash text UNIQUE CHECK (verify_token_hash IS NULL OR verify_token_hash ~ '^[0-9a-f]{64}$'),
  verify_expires_at timestamptz,
  verified_at       timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  decided_at        timestamptz,
  decided_by        uuid REFERENCES public.users (id) ON DELETE SET NULL,
  decision_reason   text CHECK (decision_reason IS NULL OR char_length(btrim(decision_reason)) BETWEEN 1 AND 500),
  organization_id   uuid REFERENCES public.organizations (id) ON DELETE SET NULL,
  CONSTRAINT organization_signups_decided_chk CHECK ((status IN ('approved', 'rejected')) = (decided_at IS NOT NULL)),
  CONSTRAINT organization_signups_review_chk CHECK (status <> 'pending_review' OR verified_at IS NOT NULL),
  CONSTRAINT organization_signups_pending_token_chk CHECK (status <> 'pending_email' OR (verify_token_hash IS NOT NULL AND verify_expires_at IS NOT NULL))
);
-- one open request per address: a second submit is a resend or a silent no-op, never a second row
CREATE UNIQUE INDEX organization_signups_open_email_uidx ON public.organization_signups (admin_email)
  WHERE status IN ('pending_email', 'pending_review');
CREATE INDEX organization_signups_created_idx ON public.organization_signups (created_at DESC, id);

ALTER TABLE public.organization_signups ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.organization_signups FORCE ROW LEVEL SECURITY;
CREATE POLICY organization_signups_owner ON public.organization_signups FOR ALL TO PUBLIC
  USING (current_user = (SELECT pg_get_userbyid(c.relowner) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                          WHERE n.nspname = 'public' AND c.relname = 'organization_signups'))
  WITH CHECK (current_user = (SELECT pg_get_userbyid(c.relowner) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                               WHERE n.nspname = 'public' AND c.relname = 'organization_signups'));
REVOKE ALL ON public.organization_signups FROM PUBLIC, figbloom_app, figbloom_worker;

-- ---------------------------------------------------------------------------------------------------------------------
-- Public: store a request. Returns the outcome only, so the route answers every case with the same 202:
--   'created'   a new request; the route e-mails the confirmation link
--   'resent'    an unconfirmed request for this address already exists; its link is replaced and the route e-mails it again
--   'duplicate' a confirmed request for this address is already waiting; nothing changes and nothing is sent
--   'capped'    too many new requests in the last 24 hours (everyone together); nothing is stored
-- One global lock serialises sign-ups, so the daily cap is exact and an address cannot get two open requests. The volume is
-- bounded by the route's per-address and per-person limits, so the lock is never contended in practice.
CREATE FUNCTION public.org_signup_submit(
  p_name text, p_kind text, p_county text, p_contact_phone text, p_admin_name text, p_email text,
  p_token_hash text, p_expires_at timestamptz, p_daily_cap integer
) RETURNS text
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_open public.organization_signups%ROWTYPE;
  v_id uuid;
BEGIN
  IF char_length(btrim(coalesce(p_name, ''))) NOT BETWEEN 2 AND 160 OR coalesce(p_name, '') ~ '[[:cntrl:]]'
     OR coalesce(p_kind, '') NOT IN ('government', 'county', 'constituency', 'group_owner')
     OR (p_county IS NOT NULL AND (char_length(btrim(p_county)) NOT BETWEEN 1 AND 80 OR p_county ~ '[[:cntrl:]]'))
     OR (p_contact_phone IS NOT NULL AND (char_length(p_contact_phone) NOT BETWEEN 6 AND 40 OR p_contact_phone !~ '^[0-9+()\s-]+$'))
     OR char_length(btrim(coalesce(p_admin_name, ''))) NOT BETWEEN 1 AND 160 OR coalesce(p_admin_name, '') ~ '[[:cntrl:]]'
     OR v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' OR char_length(v_email) > 254
     OR coalesce(p_token_hash, '') !~ '^[0-9a-f]{64}$'
     OR p_expires_at IS NULL OR p_expires_at <= now() OR p_expires_at > now() + interval '7 days'
     OR p_daily_cap IS NULL OR p_daily_cap NOT BETWEEN 1 AND 10000 THEN
    RAISE EXCEPTION 'invalid sign-up request' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('org_signup'));

  -- The cap is checked before anything about this address is looked at, so once it is reached every caller gets the same
  -- answer and the cap cannot be used to find out which addresses already have a request.
  IF (SELECT count(*) FROM public.organization_signups s WHERE s.created_at > now() - interval '1 day') >= p_daily_cap THEN
    RETURN 'capped';
  END IF;

  -- an unconfirmed request whose link has lapsed no longer holds the address
  UPDATE public.organization_signups s SET status = 'expired', verify_token_hash = NULL
   WHERE s.admin_email = v_email AND s.status = 'pending_email' AND s.verify_expires_at <= now();

  SELECT * INTO v_open FROM public.organization_signups s
   WHERE s.admin_email = v_email AND s.status IN ('pending_email', 'pending_review') FOR UPDATE;
  IF FOUND THEN
    IF v_open.status = 'pending_review' THEN
      RETURN 'duplicate';
    END IF;
    UPDATE public.organization_signups SET verify_token_hash = p_token_hash, verify_expires_at = p_expires_at WHERE id = v_open.id;
    INSERT INTO public.security_audit_events (actor_user_id, tenant_id, event_type, detail)
    VALUES (NULL, NULL, 'org_signup.verification_resent', jsonb_build_object('signupId', v_open.id));
    RETURN 'resent';
  END IF;

  INSERT INTO public.organization_signups (name, kind, county, contact_phone, admin_full_name, admin_email, verify_token_hash, verify_expires_at)
  VALUES (btrim(p_name), p_kind, nullif(btrim(coalesce(p_county, '')), ''), nullif(btrim(coalesce(p_contact_phone, '')), ''),
          btrim(p_admin_name), v_email, p_token_hash, p_expires_at)
  RETURNING id INTO v_id;
  INSERT INTO public.security_audit_events (actor_user_id, tenant_id, event_type, detail)
  VALUES (NULL, NULL, 'org_signup.submitted', jsonb_build_object('signupId', v_id, 'kind', p_kind));
  RETURN 'created';
END
$$;
REVOKE ALL ON FUNCTION public.org_signup_submit(text, text, text, text, text, text, text, timestamptz, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.org_signup_submit(text, text, text, text, text, text, text, timestamptz, integer) TO figbloom_app;

-- ---------------------------------------------------------------------------------------------------------------------
-- Public: follow the confirmation link. True once, for a request that is still waiting for its address to be confirmed and
-- whose link has not lapsed; false for every other cause (unknown, used, replaced, expired, rejected), so the answer never
-- says which. The token is cleared, so it works once.
CREATE FUNCTION public.org_signup_verify(p_token_hash text) RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_row public.organization_signups%ROWTYPE;
BEGIN
  IF coalesce(p_token_hash, '') !~ '^[0-9a-f]{64}$' THEN
    RETURN false;
  END IF;
  SELECT * INTO v_row FROM public.organization_signups s
   WHERE s.verify_token_hash = p_token_hash AND s.status = 'pending_email' FOR UPDATE;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  IF v_row.verify_expires_at <= now() THEN
    UPDATE public.organization_signups SET status = 'expired', verify_token_hash = NULL WHERE id = v_row.id;
    RETURN false;
  END IF;
  UPDATE public.organization_signups
     SET status = 'pending_review', verified_at = now(), verify_token_hash = NULL
   WHERE id = v_row.id;
  INSERT INTO public.security_audit_events (actor_user_id, tenant_id, event_type, detail)
  VALUES (NULL, NULL, 'org_signup.verified', jsonb_build_object('signupId', v_row.id));
  RETURN true;
END
$$;
REVOKE ALL ON FUNCTION public.org_signup_verify(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.org_signup_verify(text) TO figbloom_app;

-- ---------------------------------------------------------------------------------------------------------------------
-- Platform: the requests, newest first, keyset on (created_at, id). p_id returns that one request (no paging). p_status
-- filters on the EFFECTIVE status (an unconfirmed request whose link has lapsed reads 'expired' even before anything has
-- marked it). At most 201 rows.
CREATE FUNCTION public.platform_org_signups_list(p_id uuid, p_status text, p_before_at timestamptz, p_before_id uuid, p_limit integer)
RETURNS TABLE (
  id uuid,
  name text,
  kind text,
  county text,
  contact_phone text,
  admin_full_name text,
  admin_email text,
  status text,
  created_at_text text,
  verified_at_text text,
  decided_at_text text,
  decided_by_name text,
  decision_reason text,
  organization_id uuid,
  organization_slug text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_actor uuid := public.app_current_user_id();
  v_limit integer := least(greatest(coalesce(p_limit, 50), 1), 201);
BEGIN
  IF v_actor IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.platform_roles pr WHERE pr.user_id = v_actor AND pr.role = 'super_admin'
  ) THEN
    RAISE EXCEPTION 'super administrator required' USING ERRCODE = '42501';
  END IF;
  IF p_status IS NOT NULL AND p_status NOT IN ('pending_email', 'pending_review', 'approved', 'rejected', 'expired') THEN
    RAISE EXCEPTION 'unknown status' USING ERRCODE = '22023';
  END IF;
  IF (p_before_at IS NULL) <> (p_before_id IS NULL) THEN
    RAISE EXCEPTION 'cursor needs both a time and an id' USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
    SELECT s.id, s.name, s.kind, s.county, s.contact_phone, s.admin_full_name, s.admin_email, s.effective_status,
           to_char(s.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
           to_char(s.verified_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
           to_char(s.decided_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
           u.full_name, s.decision_reason, s.organization_id, o.slug
      FROM (SELECT x.*, CASE WHEN x.status = 'pending_email' AND x.verify_expires_at <= now() THEN 'expired' ELSE x.status END AS effective_status
              FROM public.organization_signups x) s
      LEFT JOIN public.users u ON u.id = s.decided_by
      LEFT JOIN public.organizations o ON o.id = s.organization_id
     WHERE (p_id IS NULL OR s.id = p_id)
       AND (p_status IS NULL OR s.effective_status = p_status)
       AND (p_before_at IS NULL OR s.created_at < p_before_at OR (s.created_at = p_before_at AND s.id > p_before_id))
     ORDER BY s.created_at DESC, s.id
     LIMIT v_limit;
END
$$;
REVOKE ALL ON FUNCTION public.platform_org_signups_list(uuid, text, timestamptz, uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.platform_org_signups_list(uuid, text, timestamptz, uuid, integer) TO figbloom_app;

-- ---------------------------------------------------------------------------------------------------------------------
-- Platform: approve a confirmed request. Creates the organisation (active), the administrator's account (invited, credential
-- '!' that no password verifies against), their org_admin membership and a password-setup token (a password_reset token, so
-- /v1/auth/password-reset/complete activates the account), and marks the request approved, all in one transaction.
--   42501 not a super administrator          P0002 unknown request
--   55000 not waiting for review             23505 'has an account' (the address is already a user) or 'is taken' (the address
--   22023 invalid slug, hash or expiry                  of the organisation) so the route can answer 409 with the right words
-- p_slug NULL derives the address from the organisation's name (lower case, letters, digits and hyphens, at most 34
-- characters, a number added until it is free); a given slug must be 3 to 40 characters of a-z, 0-9 and hyphens with no
-- hyphen at either end. The platform's own words are refused as an address in both cases.
CREATE FUNCTION public.platform_org_signup_approve(p_id uuid, p_slug text, p_setup_hash text, p_setup_expires_at timestamptz)
RETURNS TABLE (organization_id uuid, organization_slug text, admin_user_id uuid, admin_email text)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_actor uuid := public.app_current_user_id();
  v_row public.organization_signups%ROWTYPE;
  v_reserved text[] := ARRAY['admin', 'api', 'app', 'auth', 'console', 'figbloom', 'help', 'login', 'platform', 'org', 'signin', 'signup', 'status', 'support', 'www'];
  v_slug text;
  v_base text;
  v_n integer := 1;
  v_org uuid;
  v_user uuid;
BEGIN
  IF v_actor IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.platform_roles pr WHERE pr.user_id = v_actor AND pr.role = 'super_admin'
  ) THEN
    RAISE EXCEPTION 'super administrator required' USING ERRCODE = '42501';
  END IF;
  IF coalesce(p_setup_hash, '') !~ '^[0-9a-f]{64}$' OR p_setup_expires_at IS NULL OR p_setup_expires_at <= now()
     OR p_setup_expires_at > now() + interval '14 days' THEN
    RAISE EXCEPTION 'invalid setup link' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_row FROM public.organization_signups s WHERE s.id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'sign-up request not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_row.status <> 'pending_review' THEN
    RAISE EXCEPTION 'the request is not waiting for review' USING ERRCODE = '55000';
  END IF;
  IF EXISTS (SELECT 1 FROM public.users u WHERE lower(u.email) = v_row.admin_email) THEN
    RAISE EXCEPTION 'this e-mail address already has an account' USING ERRCODE = '23505';
  END IF;

  IF p_slug IS NOT NULL THEN
    IF p_slug !~ '^[a-z0-9]([a-z0-9-]{1,38}[a-z0-9])$' OR p_slug = ANY (v_reserved) THEN
      RAISE EXCEPTION 'invalid organisation address' USING ERRCODE = '22023';
    END IF;
    IF EXISTS (SELECT 1 FROM public.organizations o WHERE o.slug = p_slug) THEN
      RAISE EXCEPTION 'this organisation address is taken' USING ERRCODE = '23505';
    END IF;
    v_slug := p_slug;
  ELSE
    v_base := btrim(left(btrim(regexp_replace(lower(btrim(v_row.name)), '[^a-z0-9]+', '-', 'g'), '-'), 34), '-');
    IF char_length(v_base) < 3 THEN
      v_base := 'org-' || left(replace(v_row.id::text, '-', ''), 8);
    END IF;
    IF v_base = ANY (v_reserved) THEN
      v_base := v_base || '-org';
    END IF;
    v_slug := v_base;
    WHILE EXISTS (SELECT 1 FROM public.organizations o WHERE o.slug = v_slug) LOOP
      v_n := v_n + 1;
      IF v_n > 500 THEN
        RAISE EXCEPTION 'this organisation address is taken' USING ERRCODE = '23505';
      END IF;
      v_slug := left(v_base, 40 - char_length(v_n::text) - 1) || '-' || v_n::text;
    END LOOP;
  END IF;

  INSERT INTO public.organizations (name, slug, kind, status) VALUES (v_row.name, v_slug, v_row.kind, 'active') RETURNING id INTO v_org;
  INSERT INTO public.users (email, password_hash, full_name, status, must_change_password)
  VALUES (v_row.admin_email, '!', v_row.admin_full_name, 'invited', false) RETURNING id INTO v_user;
  INSERT INTO public.organization_memberships (user_id, organization_id, role) VALUES (v_user, v_org, 'org_admin');
  INSERT INTO public.account_tokens (kind, token_hash, user_id, email, created_by, expires_at)
  VALUES ('password_reset', p_setup_hash, v_user, v_row.admin_email, v_actor, p_setup_expires_at);

  UPDATE public.organization_signups
     SET status = 'approved', decided_at = now(), decided_by = v_actor, organization_id = v_org, verify_token_hash = NULL
   WHERE id = v_row.id;
  INSERT INTO public.security_audit_events (actor_user_id, tenant_id, event_type, detail)
  VALUES (v_actor, NULL, 'platform.org_signup.approved',
          jsonb_build_object('signupId', v_row.id, 'organizationId', v_org, 'adminUserId', v_user));

  RETURN QUERY SELECT v_org, v_slug, v_user, v_row.admin_email;
END
$$;
REVOKE ALL ON FUNCTION public.platform_org_signup_approve(uuid, text, text, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.platform_org_signup_approve(uuid, text, text, timestamptz) TO figbloom_app;

-- ---------------------------------------------------------------------------------------------------------------------
-- Platform: reject a request that has not been decided (confirmed or not). Returns whether the address had been confirmed,
-- so the route e-mails a rejection only to a mailbox whose owner asked (never to an unconfirmed address, which may be
-- somebody else's). The reason (0 to 500 characters) is kept for the platform and is never e-mailed or audited.
--   42501 not a super administrator   P0002 unknown request   55000 already approved, rejected or expired
CREATE FUNCTION public.platform_org_signup_reject(p_id uuid, p_reason text)
RETURNS TABLE (admin_email text, was_verified boolean)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_actor uuid := public.app_current_user_id();
  v_row public.organization_signups%ROWTYPE;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
BEGIN
  IF v_actor IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.platform_roles pr WHERE pr.user_id = v_actor AND pr.role = 'super_admin'
  ) THEN
    RAISE EXCEPTION 'super administrator required' USING ERRCODE = '42501';
  END IF;
  IF v_reason IS NOT NULL AND char_length(v_reason) > 500 THEN
    RAISE EXCEPTION 'reason is too long' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_row FROM public.organization_signups s WHERE s.id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'sign-up request not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_row.status NOT IN ('pending_email', 'pending_review') OR (v_row.status = 'pending_email' AND v_row.verify_expires_at <= now()) THEN
    RAISE EXCEPTION 'the request can no longer be rejected' USING ERRCODE = '55000';
  END IF;

  UPDATE public.organization_signups
     SET status = 'rejected', decided_at = now(), decided_by = v_actor, decision_reason = v_reason, verify_token_hash = NULL
   WHERE id = v_row.id;
  INSERT INTO public.security_audit_events (actor_user_id, tenant_id, event_type, detail)
  VALUES (v_actor, NULL, 'platform.org_signup.rejected',
          jsonb_build_object('signupId', v_row.id, 'verified', v_row.verified_at IS NOT NULL, 'hasReason', v_reason IS NOT NULL));

  RETURN QUERY SELECT v_row.admin_email, v_row.verified_at IS NOT NULL;
END
$$;
REVOKE ALL ON FUNCTION public.platform_org_signup_reject(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.platform_org_signup_reject(uuid, text) TO figbloom_app;

-- ---------------------------------------------------------------------------------------------------------------------
-- Platform: issue a new password-setup link to the administrator of an APPROVED request whose account is still 'invited'
-- (the first e-mail was lost, or its link lapsed). Older setup links of that account stop working. Returns false when the
-- person has already set a password (nothing is issued). The account is found through the request's own organisation and
-- membership, so this can never reset anybody else's login.
--   42501 not a super administrator   P0002 unknown request   55000 the request was not approved
CREATE FUNCTION public.platform_org_signup_reissue(p_id uuid, p_setup_hash text, p_setup_expires_at timestamptz)
RETURNS TABLE (admin_email text)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_actor uuid := public.app_current_user_id();
  v_row public.organization_signups%ROWTYPE;
  v_user uuid;
BEGIN
  IF v_actor IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.platform_roles pr WHERE pr.user_id = v_actor AND pr.role = 'super_admin'
  ) THEN
    RAISE EXCEPTION 'super administrator required' USING ERRCODE = '42501';
  END IF;
  IF coalesce(p_setup_hash, '') !~ '^[0-9a-f]{64}$' OR p_setup_expires_at IS NULL OR p_setup_expires_at <= now()
     OR p_setup_expires_at > now() + interval '14 days' THEN
    RAISE EXCEPTION 'invalid setup link' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_row FROM public.organization_signups s WHERE s.id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'sign-up request not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_row.status <> 'approved' OR v_row.organization_id IS NULL THEN
    RAISE EXCEPTION 'the request was not approved' USING ERRCODE = '55000';
  END IF;

  SELECT u.id INTO v_user
    FROM public.users u
    JOIN public.organization_memberships om ON om.user_id = u.id AND om.organization_id = v_row.organization_id AND om.role = 'org_admin'
   WHERE lower(u.email) = v_row.admin_email AND u.status = 'invited';
  IF v_user IS NULL THEN
    RETURN;
  END IF;

  UPDATE public.account_tokens SET revoked_at = now()
   WHERE user_id = v_user AND kind = 'password_reset' AND used_at IS NULL AND revoked_at IS NULL;
  INSERT INTO public.account_tokens (kind, token_hash, user_id, email, created_by, expires_at)
  VALUES ('password_reset', p_setup_hash, v_user, v_row.admin_email, v_actor, p_setup_expires_at);
  INSERT INTO public.security_audit_events (actor_user_id, tenant_id, event_type, detail)
  VALUES (v_actor, NULL, 'platform.org_signup.setup_reissued',
          jsonb_build_object('signupId', v_row.id, 'organizationId', v_row.organization_id, 'adminUserId', v_user));
  RETURN QUERY SELECT v_row.admin_email;
END
$$;
REVOKE ALL ON FUNCTION public.platform_org_signup_reissue(uuid, text, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.platform_org_signup_reissue(uuid, text, timestamptz) TO figbloom_app;
