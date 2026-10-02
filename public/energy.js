'use strict';

window.EnergyOptions = {
  bind({ root, ref, api, esc, toast }) {
    if (!root) return;
    const base = `/energy/referrals/${ref.id}`;
    const zip =
      ref.zip ||
      String(ref.address || '')
        .match(/\b\d{5}(?:-\d{4})?\b/)?.[0]
        ?.slice(0, 5) ||
      '';
    root.innerHTML = `<div class="row between"><div><h2 style="margin:0">＋ Energy options</h2><p class="small muted">Optional Texas electricity check for this customer.</p></div><button type="button" class="btn" id="energyOpen">Check energy service</button></div>
    <div id="energyBody" hidden><p class="small muted">Find the meter and compare current plans using twelve monthly usage estimates. Opening this tool does not change the opportunity or enroll the customer. The service address is sent to ComparePower when you choose Find meter.</p>
    <form id="energyMeterForm"><div class="energy-address"><div class="field"><label for="energyAddress">Service address (include unit)</label><input id="energyAddress" value="${esc(ref.address || '')}" maxlength="300" required></div><div class="field"><label for="energyZip">ZIP code</label><input id="energyZip" value="${esc(zip)}" inputmode="numeric" pattern="[0-9]{5}" maxlength="5" required></div></div><button class="btn primary">Find meter</button></form>
    <p id="energyState" class="small" role="status" aria-live="polite"></p><div id="energyMeters"></div><div id="energyResults"></div></div>`;
    const body = root.querySelector('#energyBody'),
      state = root.querySelector('#energyState'),
      meters = root.querySelector('#energyMeters'),
      results = root.querySelector('#energyResults');
    let lookup = null,
      activeJob = null,
      request = 0;
    const message = (text, kind = '', working = false) => {
      state.textContent = text;
      state.className = `small${kind ? ' alert ' + kind : ''}${working ? ' energy-working' : ''}`;
      state.setAttribute('aria-busy', String(working));
    };
    const money = (value) =>
      new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: 'USD',
      }).format(value);
    root.querySelector('#energyOpen').onclick = () => {
      body.hidden = !body.hidden;
      root.querySelector('#energyOpen').textContent = body.hidden
        ? 'Check energy service'
        : 'Close energy options';
      if (!body.hidden && activeJob) poll(activeJob, request);
    };
    root.querySelector('#energyMeterForm').onsubmit = async (e) => {
      e.preventDefault();
      const btn = e.target.querySelector('button');
      btn.disabled = true;
      const current = ++request;
      activeJob = null;
      meters.innerHTML = '';
      results.innerHTML = '';
      message('Finding service meters…', '', true);
      try {
        lookup = await api(base + '/meters', {
          method: 'POST',
          body: {
            address: root.querySelector('#energyAddress').value,
            zip: root.querySelector('#energyZip').value,
          },
        });
        if (!root.isConnected || current !== request) return;
        if (!lookup.meters.length) {
          message(
            'No matching meters were found. Check the address, unit and ZIP code. This address may be outside the supported Texas electricity market.',
            'warn'
          );
          return;
        }
        message('Choose the correct meter before comparing plans.');
        meters.innerHTML = `<details style="margin-top:1rem"><summary>Use customer-provided usage instead</summary><label for="energyUsage">Twelve monthly kWh values, separated by commas</label><input id="energyUsage" placeholder="700, 650, 800, …"><p class="small muted">Leave blank to use the meter’s estimates. Use this if meter usage is unavailable.</p></details><div class="stack" style="margin-top:1rem">${lookup.meters.map((m) => `<div class="energy-meter"><b>Meter ${esc(m.esiid)}</b><p class="small">${esc(m.address || 'Confirm the meter matches the customer’s address')} · Status: ${esc(m.status)}</p><p class="small ${m.switch_hold ? 'err-text' : 'muted'}">${m.switch_hold ? (m.hold_known ? 'Switch hold: the customer must clear it before switching.' : 'Switch-hold status unavailable: verify before recommending a plan.') : 'No switch hold reported.'}</p><button type="button" class="btn" data-energy-meter="${esc(m.esiid)}" ${m.switch_hold ? 'disabled' : ''}>Compare plans for this meter</button></div>`).join('')}</div>`;
        meters.querySelectorAll('[data-energy-meter]').forEach((b) => {
          b.onclick = async () => {
            let usage;
            const value = root.querySelector('#energyUsage').value.trim();
            if (value) {
              usage = value.split(/[,\s]+/).map(Number);
              if (
                usage.length !== 12 ||
                usage.some((n) => !Number.isFinite(n) || n < 0 || n > 50000)
              ) {
                message(
                  'Enter twelve monthly usage values between 0 and 50,000 kWh.',
                  'err'
                );
                return;
              }
            }
            meters.querySelectorAll('button').forEach((el) => {
              el.disabled = true;
            });
            message('Preparing the bill comparison…', '', true);
            results.innerHTML = '';
            try {
              const out = await api(base + '/recommendations', {
                method: 'POST',
                body: {
                  lookup_id: lookup.lookup_id,
                  esiid: b.dataset.energyMeter,
                  ...(usage ? { usage } : {}),
                },
              });
              activeJob = out.job_id;
              poll(activeJob, current);
            } catch (err) {
              message(err.message, 'err');
              meters.querySelectorAll('[data-energy-meter]').forEach((el) => {
                el.disabled = lookup.meters.find(
                  (m) => m.esiid === el.dataset.energyMeter
                )?.switch_hold;
              });
            }
          };
        });
      } catch (err) {
        if (root.isConnected && current === request)
          message(err.message, 'err');
      } finally {
        if (root.isConnected) btn.disabled = false;
      }
    };
    async function poll(id, current) {
      if (!root.isConnected || body.hidden || current !== request) return;
      try {
        const job = await api(base + '/jobs/' + id);
        if (!root.isConnected || current !== request) return;
        if (job.status === 'working') {
          message(
            `${job.stage}${job.total ? ` · ${job.completed} of ${job.total} bill calculations complete` : ''}…`,
            '',
            true
          );
          results.innerHTML = job.total
            ? `<progress max="${job.total}" value="${job.completed}" aria-label="Bill comparison progress" style="width:100%"></progress>`
            : '';
          setTimeout(() => poll(id, current), 1800);
          return;
        }
        activeJob = null;
        meters.querySelectorAll('[data-energy-meter]').forEach((el) => {
          el.disabled = lookup.meters.find(
            (m) => m.esiid === el.dataset.energyMeter
          )?.switch_hold;
        });
        if (job.status === 'failed') {
          message(job.error, 'err');
          results.innerHTML = '';
          return;
        }
        message(
          'Comparison ready. Plans are ranked by estimated annual bills at this customer’s monthly usage.',
          'ok'
        );
        results.innerHTML = `<p class="small muted">Usage source: ${esc(job.usage_source)} · ${job.average_usage} kWh/month average. Estimates include the provider’s bill calculation, not just an advertised rate. Current EFL and checkout terms control.</p>${job.warnings.map((w) => `<p class="alert warn small">${esc(w)}</p>`).join('')}
        <details><summary>Monthly usage and optional checkout details</summary><p class="small">Monthly kWh: ${job.usage.join(', ')}</p><label class="check"><input id="energyPrefill" type="checkbox"> Include customer name, email and phone in the ComparePower checkout link</label><p class="small muted">Off by default. These details will be shared with ComparePower only if you choose this option.</p><label for="energyStart">Requested start date (optional)</label><input id="energyStart" type="date"></details>
        <div class="energy-plans">${job.plans.map((p, i) => `<article class="energy-plan"><span class="tag">${i === 0 ? 'Lowest estimated bill' : `#${i + 1}`}</span><h3>${esc(p.name)}</h3><p class="small muted">${esc(p.brand)}${p.term ? ' · Term: ' + esc(p.term) : ''}</p><p><b>${money(p.monthly_bill)}/month</b> average · ${money(p.annual_bill)}/year</p><details><summary>Monthly estimated bills</summary><p class="small">${p.monthly_bills.map((bill, n) => `${n + 1}: ${money(bill)} (${job.usage[n]} kWh)`).join(' · ')}</p></details><div class="row" style="margin:.8rem 0">${p.documents.map((d) => `<a href="${esc(d.url)}" target="_blank" rel="noopener noreferrer">${esc(d.label)}</a>`).join('')}</div><div class="row"><button type="button" class="btn primary" data-energy-checkout="${esc(p.id)}">Prepare checkout link</button><button type="button" class="btn" data-energy-save="${esc(p.id)}">Save to customer record</button></div><p class="small" data-energy-feedback="${esc(p.id)}" role="status"></p></article>`).join('')}</div>`;
        for (const action of ['checkout', 'save'])
          results.querySelectorAll(`[data-energy-${action}]`).forEach((b) => {
            b.onclick = async () => {
              b.disabled = true;
              const planId = b.getAttribute(`data-energy-${action}`),
                feedback = b
                  .closest('article')
                  .querySelector('[data-energy-feedback]');
              feedback.textContent =
                action === 'save'
                  ? 'Saving recommendation…'
                  : 'Preparing attributed checkout…';
              try {
                const out = await api(base + '/' + action, {
                  method: 'POST',
                  body: {
                    job_id: id,
                    plan_id: planId,
                    include_contact:
                      !!root.querySelector('#energyPrefill')?.checked,
                    selected_start_date:
                      root.querySelector('#energyStart')?.value || '',
                  },
                });
                feedback.innerHTML =
                  action === 'save'
                    ? 'Recommendation saved as a note.'
                    : `<a class="btn primary" href="${esc(out.url)}" target="_blank" rel="noopener noreferrer">Continue to ComparePower ↗</a><span class="small muted"> Attribution follows the opportunity owner.</span>`;
                if (action === 'save') toast('Energy recommendation saved');
              } catch (err) {
                feedback.textContent = err.message;
              } finally {
                b.disabled = false;
              }
            };
          });
      } catch (err) {
        if (root.isConnected && current === request)
          message(
            `${err.message} Close and reopen energy options to check again.`,
            'err'
          );
      }
    }
    if (
      new URLSearchParams(location.hash.split('?')[1] || '').get('energy') ===
      '1'
    )
      root.querySelector('#energyOpen').click();
  },
};
