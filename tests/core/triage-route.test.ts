import { describe, expect, test } from 'bun:test';
import { routeItem, type TriageVerdict } from '../../src/modes/triage/route';

function verdict(seat: string, overrides: Partial<TriageVerdict> = {}): TriageVerdict {
  return {
    seat,
    class: 'bug',
    severity: 'high',
    route: 'fix',
    confidence: 0.8,
    reason: 'It breaks the build.',
    ...overrides,
  };
}

describe('the triage routing rule', () => {
  test('one valid verdict routes alone', () => {
    expect(routeItem([verdict('anthropic/m#triage')])).toEqual({ agreed: true, route: 'fix' });
  });

  test('two seats that agree on class and route route there', () => {
    expect(routeItem([verdict('a'), verdict('b')])).toEqual({ agreed: true, route: 'fix' });
  });

  test('two seats that disagree on the route go to a human', () => {
    expect(routeItem([verdict('a'), verdict('b', { route: 'ignore' })])).toEqual({
      agreed: false,
      route: 'human',
    });
  });

  test('a shared route is not agreement when the class differs', () => {
    expect(routeItem([verdict('a'), verdict('b', { class: 'style' })])).toEqual({
      agreed: false,
      route: 'human',
    });
  });

  test('severity and reason never affect agreement', () => {
    expect(
      routeItem([
        verdict('a', { severity: 'low', reason: 'Minor.' }),
        verdict('b', { severity: 'high', reason: 'Serious.' }),
      ]),
    ).toEqual({ agreed: true, route: 'fix' });
  });

  test('confidence never decides: the louder seat does not win a disagreement', () => {
    expect(
      routeItem([
        verdict('a', { confidence: 0.99 }),
        verdict('b', { route: 'ignore', confidence: 0.01 }),
      ]),
    ).toEqual({ agreed: false, route: 'human' });
  });

  test('more than two verdicts still need every one to agree', () => {
    expect(routeItem([verdict('a'), verdict('b'), verdict('c')])).toEqual({
      agreed: true,
      route: 'fix',
    });
    expect(routeItem([verdict('a'), verdict('b'), verdict('c', { route: 'discuss' })])).toEqual({
      agreed: false,
      route: 'human',
    });
  });

  test('no valid verdict is not a routing decision', () => {
    expect(routeItem([])).toBeNull();
  });
});
