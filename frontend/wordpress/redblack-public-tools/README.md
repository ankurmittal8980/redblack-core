# RedBlack Public Tools for WordPress

This provider-neutral WordPress plugin supplies the RedBlack Tech PAYG cost calculator and unified webinar booking form. It is designed for the existing RedBlack block theme and uses its page, button, color and spacing tokens. It does not replace the theme or add a paid webinar/CRM dependency.

## Install

Copy the redblack-public-tools directory to wp-content/plugins/redblack-public-tools, then activate RedBlack Public Tools in WordPress. It requires WordPress 6.2+ and PHP 7.4+.

Create public pages with these shortcodes in WordPress Shortcode blocks:

- [rbt_payg_calculator]
- [rbt_webinar_booking]

The calculator page should use the slug payg-cost-calculator. The booking page can be nested under the existing Services page as services/webinar-booking.

## Configure rates and sessions

Open Settings → RedBlack Public Tools while signed in as a site administrator.

- Rates start blank. Enter provider PAYG cost and RedBlack internal cost per unit before estimating a category. The plugin contains no provider price defaults.
- Each category unit label can be changed (for example, messages, minutes, 1,000 tokens or GB-months).
- Markup is optional. Blank means 0%.
- The initial schedule is Tuesday and Thursday at 19:00 in Asia/Kolkata. Days, time and IANA time zone can be changed without editing the page.
- The currency code defaults to INR and is configurable.

## Calculator model

For monthly quantity q, provider rate p, RedBlack internal cost r, and markup percentage m:

- Provider PAYG cost = q × p
- RedBlack actual cost = q × (p + r)
- Client quoted cost = RedBlack actual cost × (1 + m / 100)
- Estimated margin = client quoted cost − RedBlack actual cost

The public view displays client estimates only. The internal cost and margin view is restricted to authenticated site administrators. Costs per lead or meeting use the configured client estimate divided by the optional monthly lead or meeting count. An estimate is marked incomplete when a category with non-zero usage has no configured rate.

Estimates run in the browser and are not written to usage_events; estimates are not actual consumption.

## Webinar submissions

The page offers eight upcoming sessions generated from the configured recurring schedule. The form validates required fields on both the browser and server. Submission uses a same-site WordPress AJAX endpoint, a honeypot, a short-lived rate limit, and a consent checkbox. If no Core endpoint is configured, submissions are stored as private WordPress records visible only to users with manage_options, under Settings → Webinar Registrations. The page shows a confirmation state and a consultation link after the record is saved.

To enable the future Core handoff, configure both constants in the server-side wp-config.php or deployment environment:

    REDBLACK_CORE_API_URL = your Core API base URL
    REDBLACK_CORE_API_TOKEN = a server-side bearer token

The token is never rendered to the browser. When both settings are present, the plugin posts registrations to /api/v1/webinar-registrations and only shows confirmation after a successful 2xx response. If the configured API rejects or fails the request, the plugin does not silently fall back to local storage. The Core endpoint is a proposed integration contract and is not implemented by this plugin or by the current RedBlack Core architecture-only repository.

See ../../../docs/website-public-tools.md for the Core mapping and connection boundary.

