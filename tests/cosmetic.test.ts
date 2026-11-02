import assert from 'node:assert/strict'
import test from 'node:test'
import {
  MAX_COSMETIC_SELECTORS,
  cosmeticCss,
  cosmeticSelectorsFor,
  hasCosmeticRules,
  isSafeSelector,
  parseCosmeticList,
} from '../src/shared/cosmetic.ts'
import { CosmeticFilter } from '../src/main/cosmetic.ts'

test('only the three documented forms are parsed, and comments are skipped', () => {
  const rules = parseCosmeticList(
    [
      '! a comment',
      '',
      '##.generic',
      'example.com##.site',
      'example.com#@#.generic',
      '# not a rule',
      'no-separator-here',
      '##',
      'host-with-no-selector##',
      // The list's own header is written with `#`, and its legend lines contain the
      // separators while being prose. Parsing them filed a host named `#   host` and the
      // startup line counted three host rule sets for a list that has one, so these two
      // lines are the fixture for the whole class. `# not a rule` above cannot catch it:
      // it carries no separator, so it was skipped for the wrong reason.
      '#   host##selector      hide it on that host and its subdomains',
      '#   host#@#selector     never hide it there, even if a rule above says to',
      // A generic rule whose own selector starts with `#` still parses: `###promo` hides
      // `#promo`, and only a *single* leading `#` is a comment.
      '###promo',
    ].join('\n'),
  )
  assert.deepEqual(rules.generic, ['.generic', '#promo'])
  assert.deepEqual(rules.byHost.get('example.com'), ['.site'])
  assert.deepEqual([...(rules.exceptions.get('example.com') ?? [])], ['.generic'])
  assert.deepEqual([...rules.byHost.keys()], ['example.com'])
  assert.deepEqual([...rules.exceptions.keys()], ['example.com'])
})

test('a host rule applies to the host and its subdomains, never to a lookalike', () => {
  const rules = parseCosmeticList('example.com##.promo')
  assert.deepEqual(cosmeticSelectorsFor(rules, 'example.com'), ['.promo'])
  assert.deepEqual(cosmeticSelectorsFor(rules, 'www.example.com'), ['.promo'])
  assert.deepEqual(cosmeticSelectorsFor(rules, 'deep.www.example.com'), ['.promo'])
  // `notexample.com` merely ends with the same letters; a dot is what separates a
  // subdomain from a different site.
  assert.deepEqual(cosmeticSelectorsFor(rules, 'notexample.com'), [])
  assert.deepEqual(cosmeticSelectorsFor(rules, 'example.com.evil.test'), [])
})

test('generic rules come first, then site rules from the broadest host outward', () => {
  const rules = parseCosmeticList(
    ['##.generic', 'com##.fromCom', 'example.com##.fromSite', 'www.example.com##.fromWww'].join('\n'),
  )
  assert.deepEqual(cosmeticSelectorsFor(rules, 'www.example.com'), [
    '.generic',
    '.fromWww',
    '.fromSite',
    '.fromCom',
  ])
})

test('an exception removes a selector for that host and its subdomains only', () => {
  const rules = parseCosmeticList(
    ['##.ad-slot', 'example.com##.site-ad', 'mail.example.com#@#.ad-slot'].join('\n'),
  )
  // Where the exception applies, the generic rule is gone but the site rule stays.
  assert.deepEqual(cosmeticSelectorsFor(rules, 'mail.example.com'), ['.site-ad'])
  // Its parent is untouched, and so is everywhere else.
  assert.deepEqual(cosmeticSelectorsFor(rules, 'example.com'), ['.ad-slot', '.site-ad'])
  assert.deepEqual(cosmeticSelectorsFor(rules, 'other.test'), ['.ad-slot'])
})

test('a host-less exception is dropped: it has nothing to scope it to', () => {
  const rules = parseCosmeticList(['##.ad', '#@#.ad'].join('\n'))
  assert.equal(rules.exceptions.size, 0)
  assert.deepEqual(cosmeticSelectorsFor(rules, 'any.test'), ['.ad'])
})

test('duplicates collapse, so the same selector is hidden once', () => {
  const rules = parseCosmeticList(['##.ad', '##.ad', 'example.com##.ad'].join('\n'))
  assert.deepEqual(cosmeticSelectorsFor(rules, 'example.com'), ['.ad'])
})

test('selectors that could escape the block are refused, not escaped', () => {
  // Each of these would otherwise close the rule and open something else in a
  // stylesheet that runs inside the page.
  for (const bad of [
    '##div{display:block}',
    '##.x; body { display: none }',
    '##.x}',
    '##</style><script>alert(1)</script>',
    '##.x\\;}',
    // A control character is not selector-shaped either. (A newline cannot reach the
    // parser as part of a selector at all: lines are split first. And the NUL is built
    // at runtime rather than typed into this file: a literal zero byte makes the file
    // binary to git, which costs it diffs and blame for good.)
    `##.ad${String.fromCharCode(0)}`,
  ]) {
    const rules = parseCosmeticList(bad)
    assert.deepEqual(rules.generic, [], bad)
  }
  assert.equal(isSafeSelector('.x{'), false)
  assert.equal(isSafeSelector('.x;'), false)
  assert.equal(isSafeSelector('.x<'), false)
  assert.equal(isSafeSelector(''), false)
  assert.equal(isSafeSelector('x'.repeat(201)), false)
})

test('ordinary selectors survive validation', () => {
  for (const good of [
    '.adsbygoogle',
    'ins.adsbygoogle',
    '[data-ad-slot]',
    '[id^="google_ads_"]',
    'iframe[src*="doubleclick.net"]',
    'div > .ad-slot',
    '#main .ad, .sponsor',
    'ytd-promoted-sparkles-web-renderer',
    '[aria-label="Advertisement"]',
  ]) {
    assert.equal(isSafeSelector(good), true, good)
  }
})

test('the generated stylesheet is one rule per selector', () => {
  const css = cosmeticCss(['.ad', '#promo'])
  assert.equal(css, '.ad { display: none !important; }\n#promo { display: none !important; }\n')
  // Nothing to hide is an empty string, not an empty rule.
  assert.equal(cosmeticCss([]), '')
  // An invalid entry is dropped without taking the others with it — one bad
  // selector in a comma-joined list would switch the whole list off in CSS.
  assert.equal(cosmeticCss(['.ad', '.bad{', '#promo']), '.ad { display: none !important; }\n#promo { display: none !important; }\n')
  assert.equal(cosmeticCss(['.bad{']), '')
})

test('the selector cap bounds what one page can be given', () => {
  const lines = Array.from({ length: MAX_COSMETIC_SELECTORS + 50 }, (_, index) => `##.ad-${index}`)
  const rules = parseCosmeticList(lines.join('\n'))
  assert.equal(cosmeticSelectorsFor(rules, 'any.test').length, MAX_COSMETIC_SELECTORS)
  const css = cosmeticCss(cosmeticSelectorsFor(rules, 'any.test'))
  assert.ok(css.length <= 24_000)
  // The cap is what keeps this bounded; nothing reached the byte ceiling here.
  assert.ok(css.includes('.ad-0 {'))
})

test('hasCosmeticRules answers whether a page would be touched at all', () => {
  const rules = parseCosmeticList('! empty list')
  assert.equal(hasCosmeticRules(rules, 'example.com'), false)
  const withRules = parseCosmeticList('example.com##.promo')
  assert.equal(hasCosmeticRules(withRules, 'www.example.com'), true)
  assert.equal(hasCosmeticRules(withRules, 'other.test'), false)
  // A page with no host at all (about:blank, a data: URL) still gets generic rules.
  const generic = parseCosmeticList('##.ad')
  assert.equal(hasCosmeticRules(generic, ''), true)
})

test('an empty or hostile list parses to nothing without throwing', () => {
  for (const input of ['', 'not a list at all', '\n\n', '!']) {
    const rules = parseCosmeticList(input)
    assert.deepEqual(rules.generic, [])
    assert.equal(rules.byHost.size, 0)
  }
  // A non-string is not a list either; the app must start regardless.
  const rules = parseCosmeticList(undefined as unknown as string)
  assert.deepEqual(rules.generic, [])
})

// ---------------------------------------------------------------- main-side filter

test('a missing rule list leaves the filter inert instead of throwing', () => {
  const filter = CosmeticFilter.fromFile('/nonexistent/cosmetic.txt')
  assert.deepEqual(filter.stats(), { generic: 0, hosts: 0, paused: 0 })
  assert.equal(filter.cssFor('https://example.com/'), '')
  assert.equal(filter.hasRules('https://example.com/'), false)
})

test('the filter answers CSS for a URL and stops answering when the host is paused', () => {
  const filter = new CosmeticFilter(parseCosmeticList(['##.ad-slot', 'example.com##.site'].join('\n')))
  const css = filter.cssFor('https://www.example.com/page')
  assert.equal(css, '.ad-slot { display: none !important; }\n.site { display: none !important; }\n')

  assert.equal(filter.isPaused('example.com'), false)
  assert.equal(filter.setPaused('www.Example.COM', true), true)
  // Stored normalised, so every spelling of the host answers the same.
  assert.deepEqual(filter.pausedHosts(), ['www.example.com'])
  assert.equal(filter.cssFor('https://www.example.com/page'), '')
  // Generic rules still reach a page on another host — pausing is not global.
  assert.equal(filter.cssFor('https://other.test/'), '.ad-slot { display: none !important; }\n')
  assert.equal(filter.hasRules('https://www.example.com/page'), true)

  assert.equal(filter.setPaused('www.example.com', true), false)
  assert.equal(filter.setPaused('www.example.com', false), true)
  assert.equal(filter.cssFor('https://www.example.com/page'), css)
})

test('a page with no host still gets the generic rules, and an empty host pauses nothing', () => {
  const filter = new CosmeticFilter(parseCosmeticList('##.ad-slot'))
  assert.equal(filter.cssFor('about:blank'), '.ad-slot { display: none !important; }\n')
  assert.equal(filter.setPaused('', true), false)
  assert.equal(filter.pausedHosts().length, 0)
})

test('the persisted pause list is coerced on load', () => {
  const filter = new CosmeticFilter(parseCosmeticList('##.ad'))
  filter.loadPaused(['example.com', '.Other.Test', '', 42, null, 'example.com'])
  assert.deepEqual(filter.pausedHosts(), ['example.com', 'other.test'])
  // A non-array clears rather than accumulates — the file is the source of truth.
  filter.loadPaused('not-a-list')
  assert.deepEqual(filter.pausedHosts(), [])
})

test('the pause list is bounded, so a session file cannot grow without limit', () => {
  const filter = new CosmeticFilter(parseCosmeticList('##.ad'))
  const hosts = Array.from({ length: 260 }, (_, index) => `h${index}.test`)
  filter.loadPaused(hosts)
  assert.equal(filter.pausedHosts().length, 200)
  assert.equal(filter.setPaused('one-more.test', true), false)
})

