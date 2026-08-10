import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  isValidBanDurationsJSON,
  isValidHeuristicsJSON,
  isValidStringArrayJSON,
} from '../ipguard-validation'

describe('ipguard validation', () => {
  describe('isValidStringArrayJSON', () => {
    it('accepts empty and a valid IP array', () => {
      assert.equal(isValidStringArrayJSON(''), true)
      assert.equal(isValidStringArrayJSON('["127.0.0.1", "10.0.0.1"]'), true)
    })

    it('rejects malformed input', () => {
      assert.equal(isValidStringArrayJSON('{'), false)
      assert.equal(isValidStringArrayJSON('{"127.0.0.1": true}'), false)
      assert.equal(isValidStringArrayJSON('[127.0.0.1]'), false)
      assert.equal(isValidStringArrayJSON('[""]'), false)
    })
  })

  describe('isValidBanDurationsJSON', () => {
    it('accepts empty and durations with all three verdicts', () => {
      assert.equal(isValidBanDurationsJSON(''), true)
      assert.equal(
        isValidBanDurationsJSON(
          '{"suspect": 900, "malicious": 21600, "critical": 86400}'
        ),
        true
      )
    })

    it('rejects missing, non-positive or non-numeric verdicts', () => {
      assert.equal(isValidBanDurationsJSON('{"suspect": 900}'), false)
      assert.equal(
        isValidBanDurationsJSON(
          '{"suspect": 900, "malicious": 21600, "critical": 0}'
        ),
        false
      )
      assert.equal(
        isValidBanDurationsJSON(
          '{"suspect": "900", "malicious": 21600, "critical": 86400}'
        ),
        false
      )
      assert.equal(isValidBanDurationsJSON('[900, 21600]'), false)
    })
  })

  describe('isValidHeuristicsJSON', () => {
    it('accepts empty and an object of overrides', () => {
      assert.equal(isValidHeuristicsJSON(''), true)
      assert.equal(isValidHeuristicsJSON('{"ssh_fail_threshold": 5}'), true)
    })

    it('rejects non-objects and malformed JSON', () => {
      assert.equal(isValidHeuristicsJSON('[1, 2]'), false)
      assert.equal(isValidHeuristicsJSON('5'), false)
      assert.equal(isValidHeuristicsJSON('{"ssh_fail_threshold": }'), false)
    })
  })
})
