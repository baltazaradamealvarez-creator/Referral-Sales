'use strict';

// Deterministic public-API contracts; no live provider requests or customer data.
function provider() {
  const fixture = {
    calls: [],
    fail: false,
    missingUsage: false,
    missingBill: false,
    mentionName: false,
  };
  fixture.fetch = async (input, init = {}) => {
    const url = new URL(input);
    fixture.calls.push({ url: url.href, headers: init.headers });
    if (fixture.fail) return new Response('{}', { status: 503 });
    let data;
    if (
      url.hostname === 'ercot.api.comparepower.com' &&
      url.pathname === '/api/esiids'
    )
      data = [
        {
          esiid: '10443720002003539',
          duns: '1039940674000',
          status: 'active',
          switch_hold_indicator: 'N',
          address: '5900 Armstrong',
        },
        {
          esiid: '10443720002003540',
          duns: '1039940674000',
          status: 'active',
          switch_hold_indicator: 'Y',
          address: '5900 Armstrong, unit B',
        },
        {
          esiid: '10443720002003541',
          duns: '1039940674000',
          status: 'active',
          address: '5900 Armstrong, unit C',
        },
      ];
    else if (
      url.hostname === 'ercot.api.comparepower.com' &&
      url.pathname.endsWith('/profile')
    )
      data = {
        usage: fixture.missingUsage
          ? []
          : [700, 700, 700, 700, 700, 700, 700, 700, 700, 700, 1200, 1200],
      };
    else if (
      url.hostname === 'pricing.api.comparepower.com' &&
      url.pathname === '/api/plans/current'
    )
      data = [
        {
          _id: 'credit-plan',
          name: 'Headline credit plan',
          brand: { name: 'Credit Energy' },
          term_months: 12,
          components: [
            {
              amount: -100,
              min_usage: 1000,
              max_usage: 2000,
              multiplicative: false,
            },
          ],
          document_links: [
            { type: 'EFL', snapshot_url: 'https://example.com/credit-efl.pdf' },
          ],
        },
        {
          _id: 'steady-plan',
          name: fixture.mentionName ? 'Steady plan @owner' : 'Steady plan',
          brand: { name: 'Steady Energy' },
          term_months: 12,
          document_links: {
            EFL: { snapshot_url: 'https://example.com/steady-efl.pdf' },
            TOS: { snapshot_url: 'javascript:alert(1)' },
          },
        },
        { _id: 'missing-plan', name: 'Uncalculable plan' },
      ];
    else if (
      url.hostname === 'pricing.api.comparepower.com' &&
      /\/calculate\/\d+$/.test(url.pathname)
    ) {
      const [, id, kwh] = url.pathname.match(
        /\/plans\/([^/]+)\/calculate\/(\d+)$/
      );
      const usage = Number(kwh);
      data = {
        usage,
        total:
          fixture.missingBill || id === 'missing-plan'
            ? null
            : id === 'credit-plan'
              ? usage * 0.2 + (usage >= 1000 ? -100 : 25)
              : usage * 0.12 + 30,
      };
    } else throw new Error('Unexpected fixture URL: ' + url.href);
    return new Response(JSON.stringify(data), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  return fixture;
}
module.exports = { provider };
