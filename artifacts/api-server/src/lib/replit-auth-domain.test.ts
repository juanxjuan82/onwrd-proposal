import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isAllowedEmail } from './auth.js';

describe('ONWRD login email policy', () => {
  it('accepts an exact company-domain email', () => {
    assert.equal(isAllowedEmail('person@onwrdadvisors.com'), true);
  });

  it('is case-insensitive and trims whitespace', () => {
    assert.equal(isAllowedEmail('  PERSON@ONWRDADVISORS.COM  '), true);
  });

  it('rejects other domains and subdomains', () => {
    assert.equal(isAllowedEmail('person@example.com'), false);
    assert.equal(isAllowedEmail('person@mail.onwrdadvisors.com'), false);
    assert.equal(isAllowedEmail('person@onwrdadvisors.com.evil.example'), false);
  });

  it('rejects missing, malformed, and non-string emails', () => {
    assert.equal(isAllowedEmail(null), false);
    assert.equal(isAllowedEmail(undefined), false);
    assert.equal(isAllowedEmail('onwrdadvisors.com'), false);
    assert.equal(isAllowedEmail('@onwrdadvisors.com'), false);
    assert.equal(isAllowedEmail(123), false);
  });
});