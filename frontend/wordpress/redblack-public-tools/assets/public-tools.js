(function () {
	'use strict';

	var config = window.RBT_PUBLIC_TOOLS || {};

	function element(tag, className, text) {
		var node = document.createElement(tag);
		if (className) {
			node.className = className;
		}
		if (text !== undefined && text !== null) {
			node.textContent = String(text);
		}
		return node;
	}

	function currency(value) {
		var code = config.currency || 'INR';
		try {
			return new Intl.NumberFormat('en-IN', {
				style: 'currency',
				currency: code,
				maximumFractionDigits: 2
			}).format(value);
		} catch (error) {
			return code + ' ' + new Intl.NumberFormat('en-IN', {
				maximumFractionDigits: 2
			}).format(value);
		}
	}

	function numberValue(input) {
		if (!input || input.value.trim() === '') {
			return 0;
		}
		var value = Number(input.value);
		return Number.isFinite(value) && value >= 0 ? value : NaN;
	}

	function appendMetric(container, label, value, emphasis) {
		var metric = element('div', emphasis ? 'rbt-metric rbt-metric--emphasis' : 'rbt-metric');
		metric.appendChild(element('span', 'rbt-metric__label', label));
		metric.appendChild(element('strong', 'rbt-metric__value', value));
		container.appendChild(metric);
	}

	function initCalculator(root) {
		var form = root.querySelector('.rbt-calculator-form');
		var results = root.querySelector('[data-calculator-results]');
		if (!form || !results) {
			return;
		}
		var calculated = false;
		var rates = config.rates || {};

		function runCalculation() {
			var rows = [];
			var invalid = false;
			var hasUsage = false;
			var incomplete = false;
			var totals = {
				provider: 0,
				internal: 0,
				actual: 0,
				quote: 0,
				margin: 0
			};
			Object.keys(rates).forEach(function (key) {
				var rate = rates[key] || {};
				var input = form.querySelector('[data-usage="' + key + '"]');
				var quantity = numberValue(input);
				if (!Number.isFinite(quantity)) {
					invalid = true;
					return;
				}
				if (quantity > 0) {
					hasUsage = true;
				}
				if (config.isInternal) {
					var providerRate = rate.provider_rate;
					var internalRate = rate.internal_cost;
					if (quantity > 0 && (!rate.configured || providerRate === null || internalRate === null)) {
						incomplete = true;
					}
					providerRate = providerRate === null || providerRate === undefined ? 0 : Number(providerRate);
					internalRate = internalRate === null || internalRate === undefined ? 0 : Number(internalRate);
					var provider = quantity * providerRate;
					var internal = quantity * internalRate;
					var actual = provider + internal;
					var markup = Number(rate.markup_pct || 0);
					var quote = actual * (1 + markup / 100);
					var margin = quote - actual;
					rows.push({
						key: key,
						label: rate.label,
						unit: rate.unit,
						quantity: quantity,
						configured: !!rate.configured,
						provider: provider,
						internal: internal,
						actual: actual,
						quote: quote,
						margin: margin,
						markup: markup
					});
					totals.provider += provider;
					totals.internal += internal;
					totals.actual += actual;
					totals.quote += quote;
					totals.margin += margin;
				} else {
					if (quantity > 0 && (!rate.configured || rate.quoted_rate === null || rate.quoted_rate === undefined)) {
						incomplete = true;
					}
					var quotedRate = rate.quoted_rate === null || rate.quoted_rate === undefined ? 0 : Number(rate.quoted_rate);
					var clientPrice = quantity * quotedRate;
					rows.push({
						key: key,
						label: rate.label,
						unit: rate.unit,
						quantity: quantity,
						configured: !!rate.configured,
						quote: clientPrice
					});
					totals.quote += clientPrice;
				}
			});

			results.hidden = false;
			results.replaceChildren();
			if (invalid) {
				results.appendChild(element('p', 'rbt-alert', 'Enter a valid non-negative monthly usage amount.'));
				return;
			}
			if (!hasUsage) {
				results.appendChild(element('p', 'rbt-alert', 'Enter monthly usage for at least one category to calculate an estimate.'));
				return;
			}

			var heading = element('h3', '', 'Estimated monthly cost');
			results.appendChild(heading);
			var summary = element('div', 'rbt-summary-grid');
			if (config.isInternal) {
				appendMetric(summary, 'Provider PAYG cost', currency(totals.provider), false);
				appendMetric(summary, 'RedBlack actual cost', currency(totals.actual), false);
				appendMetric(summary, 'Client quoted cost', currency(totals.quote), true);
				var marginPct = totals.quote > 0 ? (totals.margin / totals.quote) * 100 : 0;
				appendMetric(summary, 'Estimated margin', currency(totals.margin) + ' (' + marginPct.toFixed(1) + '%)', false);
			} else {
				appendMetric(summary, 'Estimated client price / month', currency(totals.quote), true);
			}
			results.appendChild(summary);

			var leads = numberValue(form.querySelector('[data-leads]'));
			var meetings = numberValue(form.querySelector('[data-meetings]'));
			if (!Number.isFinite(leads) || !Number.isFinite(meetings)) {
				results.appendChild(element('p', 'rbt-alert', 'Lead and meeting counts must be non-negative numbers.'));
				return;
			}
			if (!incomplete && (leads > 0 || meetings > 0)) {
				var unitCosts = element('div', 'rbt-unit-costs');
				if (leads > 0) {
					appendMetric(unitCosts, 'Estimated cost per lead', currency(totals.quote / leads), false);
				}
				if (meetings > 0) {
					appendMetric(unitCosts, 'Estimated cost per meeting', currency(totals.quote / meetings), false);
				}
				results.appendChild(unitCosts);
			}

			var list = element('div', 'rbt-breakdown-list');
			rows.forEach(function (row) {
				var card = element('article', 'rbt-breakdown-card');
				var top = element('div', 'rbt-breakdown-card__top');
				top.appendChild(element('h4', '', row.label || row.key));
				top.appendChild(element('span', 'rbt-quantity', new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2 }).format(row.quantity) + ' ' + (row.unit || 'units') + ' / month'));
				card.appendChild(top);
				var metrics = element('div', 'rbt-breakdown-grid');
				if (config.isInternal) {
					appendMetric(metrics, 'Provider cost', currency(row.provider), false);
					appendMetric(metrics, 'RedBlack actual cost', currency(row.actual), false);
					appendMetric(metrics, 'Client price', currency(row.quote), true);
					appendMetric(metrics, 'Estimated margin', currency(row.margin), false);
					if (row.configured) {
						appendMetric(metrics, 'RedBlack internal cost', currency(row.internal), false);
						appendMetric(metrics, 'Markup applied', row.markup.toFixed(2) + '%', false);
					} else if (row.quantity > 0) {
						appendMetric(metrics, 'Rate status', 'Configure rates', false);
					}
				} else if (row.configured) {
					appendMetric(metrics, 'Estimated client price', currency(row.quote), true);
				} else if (row.quantity > 0) {
					appendMetric(metrics, 'Rate status', 'Not configured', false);
				} else {
					appendMetric(metrics, 'Estimated client price', currency(0), false);
				}
				card.appendChild(metrics);
				list.appendChild(card);
			});
			results.appendChild(list);

			if (incomplete) {
				results.appendChild(element('p', 'rbt-alert', 'One or more categories with usage need rates configured. The displayed total excludes unconfigured categories and must not be used as a quote.'));
			} else {
				var cta = element('div', 'wp-block-buttons rbt-result-cta');
				var talkButton = element('div', 'wp-block-button');
				var consultButton = element('div', 'wp-block-button is-style-outline');
				var talk = element('a', 'wp-block-button__link wp-element-button', 'Talk to RedBlack Tech');
				talk.href = '/contact/';
				var consult = element('a', 'wp-block-button__link wp-element-button', 'Book a Consultation');
				consult.href = '/book-a-consultation/';
				talkButton.appendChild(talk);
				consultButton.appendChild(consult);
				cta.appendChild(talkButton);
				cta.appendChild(consultButton);
				results.appendChild(cta);
			}
		}

		form.addEventListener('submit', function (event) {
			event.preventDefault();
			calculated = true;
			runCalculation();
		});
		form.addEventListener('input', function () {
			if (calculated) {
				runCalculation();
			}
		});
	}

	function initRegistration(root) {
		var form = root.querySelector('[data-rbt-registration-form]');
		var status = root.querySelector('[data-registration-status]');
		var success = root.querySelector('[data-registration-success]');
		var confirmation = root.querySelector('[data-registration-confirmation]');
		if (!form || !status || !success) {
			return;
		}
		form.addEventListener('submit', function (event) {
			event.preventDefault();
			if (!form.reportValidity()) {
				return;
			}
			var button = form.querySelector('button[type="submit"]');
			var originalText = button ? button.textContent : '';
			if (button) {
				button.disabled = true;
				button.textContent = 'Submitting…';
			}
			status.className = 'rbt-form-status';
			status.textContent = 'Submitting your registration…';

			var data = new FormData(form);
			data.append('action', 'rbtpt_register_webinar');
			data.append('nonce', config.nonce || '');

			fetch(config.ajaxUrl, {
				method: 'POST',
				credentials: 'same-origin',
				body: data
			}).then(function (response) {
				return response.json().then(function (body) {
					if (!response.ok || !body || !body.success) {
						var message = body && body.data && body.data.message ? body.data.message : 'Registration could not be completed. Please try again.';
						throw new Error(message);
					}
					return body.data;
				});
			}).then(function (body) {
				if (confirmation) {
					confirmation.textContent = body.message;
				}
				form.hidden = true;
				success.hidden = false;
				success.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
			}).catch(function (error) {
				status.className = 'rbt-form-status rbt-form-status--error';
				status.textContent = error.message || 'Registration could not be completed. Please try again.';
				if (button) {
					button.disabled = false;
					button.textContent = originalText;
				}
			});
		});
	}

	document.querySelectorAll('[data-rbt-calculator]').forEach(initCalculator);
	document.querySelectorAll('[data-rbt-webinar]').forEach(initRegistration);
}());

