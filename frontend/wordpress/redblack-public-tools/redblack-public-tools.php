<?php
/**
 * Plugin Name: RedBlack Public Tools
 * Description: Provider-neutral PAYG estimates and webinar registration for the RedBlack Tech website.
 * Version: 1.0.0
 * Requires at least: 6.2
 * Requires PHP: 7.4
 * Author: RedBlack Tech
 */

if (!defined('ABSPATH')) {
	exit;
}

define('RBT_PUBLIC_TOOLS_VERSION', '1.0.0');
define('RBT_PUBLIC_TOOLS_FILE', __FILE__);
define('RBT_PUBLIC_TOOLS_URL', plugin_dir_url(__FILE__));

function rbtpt_categories() {
	return array(
		'email'       => array('label' => 'Email', 'unit' => 'emails'),
		'whatsapp'    => array('label' => 'WhatsApp', 'unit' => 'messages'),
		'rcs'         => array('label' => 'RCS', 'unit' => 'messages'),
		'voice'       => array('label' => 'Voice / AI Calling', 'unit' => 'minutes'),
		'ai_model'    => array('label' => 'AI model usage', 'unit' => '1,000 tokens'),
		'sms'         => array('label' => 'SMS', 'unit' => 'messages'),
		'storage'     => array('label' => 'Storage / other usage', 'unit' => 'GB-months'),
	);
}

function rbtpt_defaults() {
	$rates = array();
	foreach (rbtpt_categories() as $key => $category) {
		$rates[$key] = array(
			'unit' => $category['unit'],
			'provider_rate' => '',
			'internal_cost' => '',
			'markup_pct' => '',
		);
	}

	return array(
		'currency' => 'INR',
		'rates' => $rates,
		'schedule' => array(
			'days' => array(2, 4),
			'time' => '19:00',
			'timezone' => 'Asia/Kolkata',
		),
	);
}

function rbtpt_options() {
	$defaults = rbtpt_defaults();
	$saved = get_option('rbt_public_tools_options', array());
	if (!is_array($saved)) {
		$saved = array();
	}
	$options = wp_parse_args($saved, $defaults);
	$options['rates'] = array_replace_recursive($defaults['rates'], isset($saved['rates']) && is_array($saved['rates']) ? $saved['rates'] : array());
	$options['schedule'] = array_replace($defaults['schedule'], isset($saved['schedule']) && is_array($saved['schedule']) ? $saved['schedule'] : array());
	return $options;
}

function rbtpt_clean_amount($value, $max = 1000000000) {
	if ($value === '' || $value === null) {
		return '';
	}
	if (!is_numeric($value) || !is_finite((float) $value)) {
		return '';
	}
	$number = (float) $value;
	if ($number < 0 || $number > $max) {
		return '';
	}
	return rtrim(rtrim(number_format($number, 8, '.', ''), '0'), '.');
}

function rbtpt_sanitize_options($input) {
	$defaults = rbtpt_defaults();
	$clean = $defaults;
	if (!is_array($input)) {
		return $clean;
	}

	$currency = isset($input['currency']) ? strtoupper(sanitize_text_field($input['currency'])) : 'INR';
	$clean['currency'] = preg_match('/^[A-Z]{3}$/', $currency) ? $currency : 'INR';

	$days = isset($input['schedule']['days']) && is_array($input['schedule']['days']) ? array_map('intval', $input['schedule']['days']) : array();
	$clean['schedule']['days'] = array_values(array_unique(array_filter($days, function ($day) {
		return $day >= 0 && $day <= 6;
	})));

	$time = isset($input['schedule']['time']) ? sanitize_text_field($input['schedule']['time']) : '19:00';
	$clean['schedule']['time'] = preg_match('/^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/', $time) ? $time : '19:00';

	$timezone = isset($input['schedule']['timezone']) ? sanitize_text_field($input['schedule']['timezone']) : 'Asia/Kolkata';
	try {
		new DateTimeZone($timezone);
		$clean['schedule']['timezone'] = $timezone;
	} catch (Exception $exception) {
		$clean['schedule']['timezone'] = 'Asia/Kolkata';
	}

	foreach (rbtpt_categories() as $key => $category) {
		$row = isset($input['rates'][$key]) && is_array($input['rates'][$key]) ? $input['rates'][$key] : array();
		$unit = isset($row['unit']) ? sanitize_text_field($row['unit']) : $category['unit'];
		$clean['rates'][$key]['unit'] = $unit !== '' ? mb_substr($unit, 0, 48) : $category['unit'];
		$clean['rates'][$key]['provider_rate'] = rbtpt_clean_amount(isset($row['provider_rate']) ? $row['provider_rate'] : '');
		$clean['rates'][$key]['internal_cost'] = rbtpt_clean_amount(isset($row['internal_cost']) ? $row['internal_cost'] : '');
		$clean['rates'][$key]['markup_pct'] = rbtpt_clean_amount(isset($row['markup_pct']) ? $row['markup_pct'] : '', 10000);
	}

	return $clean;
}

function rbtpt_add_settings_page() {
	add_options_page(
		'RedBlack Public Tools',
		'RedBlack Public Tools',
		'manage_options',
		'rbt-public-tools',
		'rbtpt_render_settings_page'
	);
}
add_action('admin_menu', 'rbtpt_add_settings_page');

function rbtpt_register_settings() {
	register_setting('rbtpt_settings', 'rbt_public_tools_options', array(
		'type' => 'array',
		'sanitize_callback' => 'rbtpt_sanitize_options',
		'default' => rbtpt_defaults(),
	));
}
add_action('admin_init', 'rbtpt_register_settings');

function rbtpt_render_settings_page() {
	if (!current_user_can('manage_options')) {
		return;
	}
	$options = rbtpt_options();
	$days = array(
		0 => 'Sunday',
		1 => 'Monday',
		2 => 'Tuesday',
		3 => 'Wednesday',
		4 => 'Thursday',
		5 => 'Friday',
		6 => 'Saturday',
	);
	?>
	<div class="wrap">
		<h1>RedBlack Public Tools</h1>
		<p>Set the estimate rates and recurring webinar schedule used by the public pages. Blank cost fields stay unpriced; no provider prices are bundled with the calculator.</p>
		<form method="post" action="options.php">
			<?php settings_fields('rbtpt_settings'); ?>
			<h2>PAYG rates</h2>
			<p>Enter amounts in the selected currency per configured unit. RedBlack actual cost is provider PAYG cost plus RedBlack internal cost. Markup is optional and applied to actual cost.</p>
			<table class="widefat striped" style="max-width:1100px">
				<thead>
					<tr>
						<th scope="col">Category</th>
						<th scope="col">Unit</th>
						<th scope="col">Provider PAYG / unit</th>
						<th scope="col">RedBlack internal / unit</th>
						<th scope="col">Markup %</th>
					</tr>
				</thead>
				<tbody>
					<?php foreach (rbtpt_categories() as $key => $category) : $rate = $options['rates'][$key]; ?>
						<tr>
							<th scope="row"><?php echo esc_html($category['label']); ?></th>
							<td><input class="regular-text" type="text" name="rbt_public_tools_options[rates][<?php echo esc_attr($key); ?>][unit]" value="<?php echo esc_attr($rate['unit']); ?>" maxlength="48" aria-label="<?php echo esc_attr($category['label']); ?> unit"></td>
							<td><input type="number" min="0" step="any" inputmode="decimal" name="rbt_public_tools_options[rates][<?php echo esc_attr($key); ?>][provider_rate]" value="<?php echo esc_attr($rate['provider_rate']); ?>" aria-label="<?php echo esc_attr($category['label']); ?> provider PAYG rate"></td>
							<td><input type="number" min="0" step="any" inputmode="decimal" name="rbt_public_tools_options[rates][<?php echo esc_attr($key); ?>][internal_cost]" value="<?php echo esc_attr($rate['internal_cost']); ?>" aria-label="<?php echo esc_attr($category['label']); ?> RedBlack internal cost"></td>
							<td><input type="number" min="0" max="10000" step="any" inputmode="decimal" name="rbt_public_tools_options[rates][<?php echo esc_attr($key); ?>][markup_pct]" value="<?php echo esc_attr($rate['markup_pct']); ?>" aria-label="<?php echo esc_attr($category['label']); ?> markup percentage"></td>
						</tr>
					<?php endforeach; ?>
				</tbody>
			</table>
			<h2>Webinar schedule</h2>
			<p>Session dates are generated from these weekdays and time zone. The initial schedule is Tuesday and Thursday at 7:00 PM IST.</p>
			<fieldset>
				<legend class="screen-reader-text">Webinar days</legend>
				<?php foreach ($days as $day_number => $day_name) : ?>
					<label style="display:inline-block;margin:0 16px 8px 0">
						<input type="checkbox" name="rbt_public_tools_options[schedule][days][]" value="<?php echo esc_attr($day_number); ?>" <?php checked(in_array($day_number, array_map('intval', (array) $options['schedule']['days']), true)); ?>>
						<?php echo esc_html($day_name); ?>
					</label>
				<?php endforeach; ?>
			</fieldset>
			<p>
				<label for="rbtpt-schedule-time"><strong>Session time</strong></label><br>
				<input id="rbtpt-schedule-time" type="time" name="rbt_public_tools_options[schedule][time]" value="<?php echo esc_attr($options['schedule']['time']); ?>">
			</p>
			<p>
				<label for="rbtpt-schedule-timezone"><strong>Time zone</strong></label><br>
				<input id="rbtpt-schedule-timezone" class="regular-text" type="text" name="rbt_public_tools_options[schedule][timezone]" value="<?php echo esc_attr($options['schedule']['timezone']); ?>" maxlength="64">
				<span class="description">Use an IANA time zone, for example Asia/Kolkata.</span>
			</p>
			<p>
				<label for="rbtpt-currency"><strong>Currency code</strong></label><br>
				<input id="rbtpt-currency" class="small-text" type="text" name="rbt_public_tools_options[currency]" value="<?php echo esc_attr($options['currency']); ?>" maxlength="3">
			</p>
			<?php submit_button('Save RedBlack Public Tools settings'); ?>
		</form>
		<hr>
		<p><strong>Core connection:</strong> webinar submissions stay in a private WordPress registration record until a RedBlack Core endpoint is configured server-side. See the plugin README before connecting an API.</p>
	</div>
	<?php
}

function rbtpt_register_registration_type() {
	$caps = array(
		'edit_post' => 'manage_options',
		'read_post' => 'manage_options',
		'delete_post' => 'manage_options',
		'edit_posts' => 'manage_options',
		'edit_others_posts' => 'manage_options',
		'publish_posts' => 'manage_options',
		'read_private_posts' => 'manage_options',
		'create_posts' => 'manage_options',
	);
	register_post_type('rbt_webinar_registration', array(
		'labels' => array(
			'name' => 'Webinar Registrations',
			'singular_name' => 'Webinar Registration',
			'menu_name' => 'Webinar Registrations',
			'edit_item' => 'View Webinar Registration',
			'view_item' => 'View Webinar Registration',
		),
		'public' => false,
		'show_ui' => true,
		'show_in_menu' => 'options-general.php',
		'show_in_rest' => false,
		'exclude_from_search' => true,
		'publicly_queryable' => false,
		'has_archive' => false,
		'rewrite' => false,
		'supports' => array('title'),
		'capability_type' => array('rbt_webinar_registration', 'rbt_webinar_registrations'),
		'capabilities' => $caps,
		'map_meta_cap' => true,
	));
}
add_action('init', 'rbtpt_register_registration_type');

function rbtpt_registration_columns($columns) {
	return array(
		'cb' => isset($columns['cb']) ? $columns['cb'] : '<input type="checkbox">',
		'title' => 'Session',
		'rbtpt_name' => 'Name',
		'rbtpt_email' => 'Email',
		'rbtpt_phone' => 'Phone',
		'rbtpt_company' => 'Company',
		'date' => 'Received',
	);
}
add_filter('manage_rbt_webinar_registration_posts_columns', 'rbtpt_registration_columns');

function rbtpt_registration_column_content($column, $post_id) {
	$meta = array(
		'rbtpt_name' => '_rbtpt_name',
		'rbtpt_email' => '_rbtpt_email',
		'rbtpt_phone' => '_rbtpt_phone',
		'rbtpt_company' => '_rbtpt_company',
	);
	if (isset($meta[$column])) {
		echo esc_html(get_post_meta($post_id, $meta[$column], true));
	}
}
add_action('manage_rbt_webinar_registration_posts_custom_column', 'rbtpt_registration_column_content', 10, 2);

function rbtpt_add_registration_meta_box() {
	add_meta_box('rbtpt-registration-details', 'Registration details', 'rbtpt_render_registration_meta_box', 'rbt_webinar_registration', 'normal', 'high');
}
add_action('add_meta_boxes_rbt_webinar_registration', 'rbtpt_add_registration_meta_box');

function rbtpt_render_registration_meta_box($post) {
	$fields = array(
		'Name' => '_rbtpt_name',
		'Email' => '_rbtpt_email',
		'Phone' => '_rbtpt_phone',
		'Company' => '_rbtpt_company',
		'Website' => '_rbtpt_website',
		'Business challenge' => '_rbtpt_challenge',
		'Selected session' => '_rbtpt_session',
		'Consent recorded' => '_rbtpt_consent',
		'Received through' => '_rbtpt_source',
	);
	echo '<dl>';
	foreach ($fields as $label => $key) {
		$value = get_post_meta($post->ID, $key, true);
		echo '<dt><strong>' . esc_html($label) . '</strong></dt><dd>' . nl2br(esc_html($value)) . '</dd>';
	}
	echo '</dl>';
}

function rbtpt_schedule_sessions($limit = 8) {
	$options = rbtpt_options();
	$schedule = $options['schedule'];
	try {
		$timezone = new DateTimeZone($schedule['timezone']);
	} catch (Exception $exception) {
		$timezone = new DateTimeZone('Asia/Kolkata');
	}
	$now = new DateTimeImmutable('now', $timezone);
	$today = new DateTimeImmutable('today', $timezone);
	$parts = explode(':', $schedule['time']);
	$hour = isset($parts[0]) ? (int) $parts[0] : 19;
	$minute = isset($parts[1]) ? (int) $parts[1] : 0;
	$days = array_map('intval', (array) $schedule['days']);
	$sessions = array();

	for ($offset = 0; $offset < 60 && count($sessions) < $limit; $offset++) {
		$date = $today->modify('+' . $offset . ' days');
		if (!in_array((int) $date->format('w'), $days, true)) {
			continue;
		}
		$session = $date->setTime($hour, $minute);
		if ($session <= $now) {
			continue;
		}
		$sessions[] = $session;
	}
	return $sessions;
}

function rbtpt_format_session($session) {
	return wp_date('l, j F', $session->getTimestamp(), $session->getTimezone()) . ' — ' . wp_date('g:i A T', $session->getTimestamp(), $session->getTimezone());
}

function rbtpt_rate_payload() {
	$options = rbtpt_options();
	$internal = current_user_can('manage_options');
	$payload = array();
	foreach (rbtpt_categories() as $key => $category) {
		$rate = $options['rates'][$key];
		$provider = $rate['provider_rate'] === '' ? null : (float) $rate['provider_rate'];
		$internal_cost = $rate['internal_cost'] === '' ? null : (float) $rate['internal_cost'];
		$markup = $rate['markup_pct'] === '' ? 0.0 : (float) $rate['markup_pct'];
		$configured = $provider !== null && $internal_cost !== null;
		$quote = $configured ? (($provider + $internal_cost) * (1 + ($markup / 100))) : null;
		$payload[$key] = array(
			'label' => $category['label'],
			'unit' => $rate['unit'],
			'configured' => $configured,
			'quoted_rate' => $quote,
		);
		if ($internal) {
			$payload[$key]['provider_rate'] = $provider;
			$payload[$key]['internal_cost'] = $internal_cost;
			$payload[$key]['markup_pct'] = $markup;
		}
	}
	return $payload;
}

function rbtpt_enqueue_assets() {
	if (!is_singular()) {
		return;
	}
	$post = get_post();
	if (!$post) {
		return;
	}
	$has_calculator = has_shortcode($post->post_content, 'rbt_payg_calculator');
	$has_webinar = has_shortcode($post->post_content, 'rbt_webinar_booking');
	if (!$has_calculator && !$has_webinar) {
		return;
	}
	wp_enqueue_style('rbt-public-tools', RBT_PUBLIC_TOOLS_URL . 'assets/public-tools.css', array(), RBT_PUBLIC_TOOLS_VERSION);
	wp_enqueue_script('rbt-public-tools', RBT_PUBLIC_TOOLS_URL . 'assets/public-tools.js', array(), RBT_PUBLIC_TOOLS_VERSION, true);
	wp_localize_script('rbt-public-tools', 'RBT_PUBLIC_TOOLS', array(
		'ajaxUrl' => admin_url('admin-ajax.php'),
		'nonce' => wp_create_nonce('rbtpt_webinar_registration'),
		'currency' => rbtpt_options()['currency'],
		'isInternal' => current_user_can('manage_options'),
		'rates' => rbtpt_rate_payload(),
	));
}
add_action('wp_enqueue_scripts', 'rbtpt_enqueue_assets');

function rbtpt_calculator_shortcode() {
	$rates = rbtpt_rate_payload();
	$categories = rbtpt_categories();
	$is_internal = current_user_can('manage_options');
	ob_start();
	?>
	<section class="rbt-tool rbt-calculator" data-rbt-calculator aria-labelledby="rbt-calculator-heading">
		<div class="rbt-panel">
			<p class="rbt-eyebrow">Monthly PAYG estimate</p>
			<h2 id="rbt-calculator-heading">Build an operating-cost estimate</h2>
			<p>Enter expected monthly usage for each channel. The estimate uses RedBlack Tech rates configured by an administrator; no default provider prices are assumed.</p>
			<form class="rbt-calculator-form">
				<div class="rbt-usage-grid">
					<?php foreach ($categories as $key => $category) : ?>
						<label class="rbt-field">
							<span><?php echo esc_html($category['label']); ?> <small>(<?php echo esc_html($rates[$key]['unit']); ?> / month)</small></span>
							<input type="number" min="0" step="any" inputmode="decimal" value="0" data-usage="<?php echo esc_attr($key); ?>" aria-label="<?php echo esc_attr($category['label']); ?> monthly usage">
						</label>
					<?php endforeach; ?>
					<label class="rbt-field">
						<span>Leads per month <small>(optional)</small></span>
						<input type="number" min="0" step="1" inputmode="numeric" value="" data-leads aria-label="Leads per month">
					</label>
					<label class="rbt-field">
						<span>Meetings per month <small>(optional)</small></span>
						<input type="number" min="0" step="1" inputmode="numeric" value="" data-meetings aria-label="Meetings per month">
					</label>
				</div>
				<button class="wp-element-button" type="submit">Calculate Your Estimated Operating Cost</button>
			</form>
			<p class="rbt-disclaimer">This is an estimate based on configured rates and the monthly usage you enter. Actual provider charges may vary by provider, destination, usage type, taxes and current pricing. It is not a final quote.</p>
		</div>
		<div class="rbt-results" data-calculator-results aria-live="polite" hidden></div>
		<?php if ($is_internal) : ?>
			<p class="rbt-internal-note">Internal quoting view: provider cost, RedBlack actual cost, client price and estimated margin are visible to authorized site administrators only.</p>
		<?php endif; ?>
	</section>
	<?php
	return ob_get_clean();
}
add_shortcode('rbt_payg_calculator', 'rbtpt_calculator_shortcode');

function rbtpt_webinar_shortcode() {
	$sessions = rbtpt_schedule_sessions(8);
	$timezone = rbtpt_options()['schedule']['timezone'];
	ob_start();
	?>
	<section class="rbt-tool rbt-webinar" data-rbt-webinar>
		<div class="rbt-webinar-intro">
			<p class="rbt-eyebrow">One RedBlack Tech webinar program</p>
			<h2>Build a more connected lead-to-meeting system</h2>
			<p class="rbt-lead">A practical session on connecting lead capture, qualification, follow-up and meeting booking across your website, CRM and communication workflows.</p>
			<div class="rbt-webinar-columns">
				<div class="rbt-panel rbt-info-card">
					<h3>What you’ll learn</h3>
					<ul>
						<li>Map an enquiry from first capture to the next useful action.</li>
						<li>Plan qualification and handoffs for a human sales team.</li>
						<li>Structure reminders and follow-up around customer consent.</li>
						<li>Track leads, meetings and communication operating costs.</li>
					</ul>
				</div>
				<div class="rbt-panel rbt-info-card">
					<h3>Who should attend</h3>
					<ul>
						<li>Business owners and operators reviewing lead follow-up.</li>
						<li>Sales and marketing leaders responsible for enquiries and appointments.</li>
						<li>Teams evaluating CRM, WhatsApp and AI-assisted workflows.</li>
					</ul>
				</div>
			</div>
			<p class="rbt-schedule-note">Choose a session below. The recurring schedule is configurable by a RedBlack Tech administrator. All times are shown in <?php echo esc_html($timezone); ?>.</p>
		</div>
		<div class="rbt-panel rbt-registration-panel">
			<h2 id="rbt-registration-heading">Reserve your webinar session</h2>
			<?php if (empty($sessions)) : ?>
				<p>There are no sessions available to book right now. Please <a href="/contact/">contact RedBlack Tech</a>.</p>
			<?php else : ?>
				<form class="rbt-registration-form" data-rbt-registration-form aria-labelledby="rbt-registration-heading">
					<div class="rbt-form-grid">
						<label class="rbt-field rbt-field--wide">
							<span>Date and session <b aria-hidden="true">*</b></span>
							<select name="session" required>
								<option value="">Select a session</option>
								<?php foreach ($sessions as $session) : ?>
									<option value="<?php echo esc_attr($session->format('Y-m-d\TH:i')); ?>"><?php echo esc_html(rbtpt_format_session($session)); ?></option>
								<?php endforeach; ?>
							</select>
						</label>
						<label class="rbt-field">
							<span>Name <b aria-hidden="true">*</b></span>
							<input name="name" type="text" autocomplete="name" maxlength="120" required>
						</label>
						<label class="rbt-field">
							<span>Email <b aria-hidden="true">*</b></span>
							<input name="email" type="email" autocomplete="email" maxlength="190" required>
						</label>
						<label class="rbt-field">
							<span>Phone <b aria-hidden="true">*</b></span>
							<input name="phone" type="tel" autocomplete="tel" inputmode="tel" pattern="[0-9+() .-]{7,24}" maxlength="24" required>
						</label>
						<label class="rbt-field">
							<span>Company <b aria-hidden="true">*</b></span>
							<input name="company" type="text" autocomplete="organization" maxlength="150" required>
						</label>
						<label class="rbt-field rbt-field--wide">
							<span>Website <small>(optional)</small></span>
							<input name="website" type="url" inputmode="url" placeholder="https://example.com" maxlength="255">
						</label>
						<label class="rbt-field rbt-field--wide">
							<span>What business challenge would you like to discuss? <small>(optional)</small></span>
							<textarea name="challenge" rows="4" maxlength="2000"></textarea>
						</label>
						<div class="rbt-honeypot" aria-hidden="true">
							<label>Leave this field empty<input name="website_confirm" type="text" tabindex="-1" autocomplete="off"></label>
						</div>
						<label class="rbt-consent rbt-field--wide">
							<input name="consent" type="checkbox" value="1" required>
							<span>I agree that RedBlack Tech may use these details to manage my webinar registration and respond to this request. See the <a href="/privacy-policy/">Privacy Policy</a>. <b aria-hidden="true">*</b></span>
						</label>
					</div>
					<button class="wp-element-button" type="submit">Register for the Webinar</button>
					<p class="rbt-form-note">Your details are used to handle this registration and related follow-up. No paid webinar or CRM platform is required.</p>
					<p class="rbt-form-status" data-registration-status role="status" aria-live="polite"></p>
				</form>
				<div class="rbt-registration-success" data-registration-success role="status" aria-live="polite" hidden>
					<p class="rbt-success-label">Registration received</p>
					<h3>You’re on the session list.</h3>
					<p data-registration-confirmation></p>
					<div class="wp-block-buttons">
						<div class="wp-block-button"><a class="wp-block-button__link wp-element-button" href="/book-a-consultation/">Book a Consultation</a></div>
						<div class="wp-block-button is-style-outline"><a class="wp-block-button__link wp-element-button" href="/payg-cost-calculator/">Calculate Your Estimated Operating Cost</a></div>
					</div>
				</div>
			<?php endif; ?>
		</div>
	</section>
	<?php
	return ob_get_clean();
}
add_shortcode('rbt_webinar_booking', 'rbtpt_webinar_shortcode');

function rbtpt_find_session($value) {
	$options = rbtpt_options();
	try {
		$timezone = new DateTimeZone($options['schedule']['timezone']);
	} catch (Exception $exception) {
		$timezone = new DateTimeZone('Asia/Kolkata');
	}
	foreach (rbtpt_schedule_sessions(16) as $session) {
		if (hash_equals($session->format('Y-m-d\TH:i'), $value)) {
			return $session;
		}
	}
	return false;
}

function rbtpt_submit_to_core($payload) {
	$base = defined('REDBLACK_CORE_API_URL') ? untrailingslashit((string) REDBLACK_CORE_API_URL) : '';
	$token = defined('REDBLACK_CORE_API_TOKEN') ? (string) REDBLACK_CORE_API_TOKEN : '';
	if ($base === '' && $token === '') {
		return null;
	}
	if ($base === '' || $token === '' || !wp_http_validate_url($base)) {
		return new WP_Error('rbtpt_core_config', 'Registration could not be completed. Please try again or contact RedBlack Tech.');
	}
	$endpoint = $base . '/api/v1/webinar-registrations';
	$response = wp_remote_post($endpoint, array(
		'timeout' => 10,
		'redirection' => 0,
		'headers' => array(
			'Authorization' => 'Bearer ' . $token,
			'Content-Type' => 'application/json',
			'Idempotency-Key' => hash('sha256', strtolower($payload['email']) . '|' . $payload['session_at']),
		),
		'body' => wp_json_encode(array(
			'source' => 'redblack-tech-website',
			'session_at' => $payload['session_at'],
			'contact' => array(
				'name' => $payload['name'],
				'email' => $payload['email'],
				'phone' => $payload['phone'],
				'company' => $payload['company'],
				'website' => $payload['website'],
			),
			'business_challenge' => $payload['challenge'],
			'consent_recorded' => true,
		)),
	));
	if (is_wp_error($response)) {
		return new WP_Error('rbtpt_core_unavailable', 'Registration could not be completed. Please try again or contact RedBlack Tech.');
	}
	$status = (int) wp_remote_retrieve_response_code($response);
	if ($status < 200 || $status >= 300) {
		return new WP_Error('rbtpt_core_rejected', 'Registration could not be completed. Please try again or contact RedBlack Tech.');
	}
	return true;
}

function rbtpt_store_local_registration($payload, $session) {
	$post_id = wp_insert_post(wp_slash(array(
		'post_type' => 'rbt_webinar_registration',
		'post_status' => 'private',
		'post_title' => 'Webinar registration — ' . $session->format('Y-m-d H:i'),
		'post_content' => '',
	)), true);
	if (is_wp_error($post_id)) {
		return $post_id;
	}
	$values = array(
		'_rbtpt_name' => $payload['name'],
		'_rbtpt_email' => $payload['email'],
		'_rbtpt_phone' => $payload['phone'],
		'_rbtpt_company' => $payload['company'],
		'_rbtpt_website' => $payload['website'],
		'_rbtpt_challenge' => $payload['challenge'],
		'_rbtpt_session' => $session->format(DateTimeInterface::ATOM),
		'_rbtpt_consent' => 'Yes — ' . current_time('mysql', true),
		'_rbtpt_source' => 'RedBlack Tech webinar booking page',
	);
	foreach ($values as $key => $value) {
		update_post_meta($post_id, $key, $value);
	}
	return $post_id;
}

function rbtpt_registration_rate_limited($email) {
	$ip = isset($_SERVER['REMOTE_ADDR']) ? sanitize_text_field(wp_unslash($_SERVER['REMOTE_ADDR'])) : '';
	$key = 'rbtpt_rate_' . hash_hmac('sha256', strtolower($email) . '|' . $ip, wp_salt('auth'));
	$count = (int) get_transient($key);
	if ($count >= 3) {
		return true;
	}
	set_transient($key, $count + 1, 30 * MINUTE_IN_SECONDS);
	return false;
}

function rbtpt_ajax_register_webinar() {
	$nonce = isset($_POST['nonce']) ? sanitize_text_field(wp_unslash($_POST['nonce'])) : '';
	if (!wp_verify_nonce($nonce, 'rbtpt_webinar_registration')) {
		wp_send_json_error(array('message' => 'This form has expired. Refresh the page and try again.'), 403);
	}
	$honeypot = isset($_POST['website_confirm']) ? trim((string) wp_unslash($_POST['website_confirm'])) : '';
	if ($honeypot !== '') {
		wp_send_json_error(array('message' => 'Registration could not be completed. Please try again.'), 400);
	}

	$name = isset($_POST['name']) ? sanitize_text_field(wp_unslash($_POST['name'])) : '';
	$email = isset($_POST['email']) ? sanitize_email(wp_unslash($_POST['email'])) : '';
	$phone = isset($_POST['phone']) ? sanitize_text_field(wp_unslash($_POST['phone'])) : '';
	$company = isset($_POST['company']) ? sanitize_text_field(wp_unslash($_POST['company'])) : '';
	$website = isset($_POST['website']) ? esc_url_raw(wp_unslash($_POST['website'])) : '';
	$challenge = isset($_POST['challenge']) ? sanitize_textarea_field(wp_unslash($_POST['challenge'])) : '';
	$session_value = isset($_POST['session']) ? sanitize_text_field(wp_unslash($_POST['session'])) : '';
	$consent = isset($_POST['consent']) && sanitize_text_field(wp_unslash($_POST['consent'])) === '1';

	if ($name === '' || strlen($name) > 120 || !is_email($email) || strlen($email) > 190 || !preg_match('/^[0-9+() .-]{7,24}$/', $phone) || $company === '' || strlen($company) > 150 || strlen($website) > 255 || strlen($challenge) > 2000 || !$consent) {
		wp_send_json_error(array('message' => 'Check the required fields and try again.'), 422);
	}
	if ($website !== '' && !wp_http_validate_url($website)) {
		wp_send_json_error(array('message' => 'Enter a valid website address or leave that field blank.'), 422);
	}
	$session = rbtpt_find_session($session_value);
	if (!$session) {
		wp_send_json_error(array('message' => 'That session is no longer available. Refresh the page and choose another time.'), 422);
	}
	if (rbtpt_registration_rate_limited($email)) {
		wp_send_json_error(array('message' => 'Too many attempts. Please wait a little and try again.'), 429);
	}

	$payload = array(
		'name' => $name,
		'email' => $email,
		'phone' => $phone,
		'company' => $company,
		'website' => $website,
		'challenge' => $challenge,
		'session_at' => $session->format(DateTimeInterface::ATOM),
	);
	$core_result = rbtpt_submit_to_core($payload);
	if (is_wp_error($core_result)) {
		wp_send_json_error(array('message' => $core_result->get_error_message()), 503);
	}
	if ($core_result === null) {
		$stored = rbtpt_store_local_registration($payload, $session);
		if (is_wp_error($stored)) {
			wp_send_json_error(array('message' => 'Registration could not be saved. Please try again or contact RedBlack Tech.'), 500);
		}
	}

	wp_send_json_success(array(
		'message' => 'Your registration request has been received for ' . rbtpt_format_session($session) . '. RedBlack Tech may follow up using the details you provided.',
	));
}
add_action('wp_ajax_rbtpt_register_webinar', 'rbtpt_ajax_register_webinar');
add_action('wp_ajax_nopriv_rbtpt_register_webinar', 'rbtpt_ajax_register_webinar');

