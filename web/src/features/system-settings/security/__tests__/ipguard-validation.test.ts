import { describe, expect, it } from 'vitest'

import {
  isValidBanDurationsJSON,
  isValidHeuristicsJSON,
  isValidStringArrayJSON,
} from '../ipguard-validation'

describe('ipguard validation', () => {
  describe('isValidStringArrayJSON', () => {
    it('accepts empty and a valid IP array', () => {
      expect(isValidStringArrayJSON('')).toBe(true)
      expect(isValidStringArrayJSON('["127.0.0.1", "10.0.0.1"]')).toBe(true)
    })

    it('rejects malformed input', () => {
      expect(isValidStringArrayJSON('{')).toBe(false)
      expect(isValidStringArrayJSON('{"127.0.0.1": true}')).toBe(false)
      expect(isValidStringArrayJSON('[127.0.0.1]')).toBe(false)
      expect(isValidStringArrayJSON('[""]')).toBe(false)
    })
  })

  describe('isValidBanDurationsJSON', () => {
    it('accepts empty and durations with all three verdicts', () => {
      expect(isValidBanDurationsJSON('')).toBe(true)
      expect(
        isValidBanDurationsJSON(
          '{"suspect": 900, "malicious": 21600, "critical": 86400}'
        )
      ).toBe(true)
    })

    it('rejects missing, non-positive or non-numeric verdicts', () => {
      expect(isValidBanDurationsJSON('{"suspect": 900}')).toBe(false)
      expect(
        isValidBanDurationsJSON(
          '{"suspect": 900, "malicious": 21600, "critical": 0}'
        )
      ).toBe(false)
      expect(
        isValidBanDurationsJSON(
          '{"suspect": "900", "malicious": 21600, "critical": 86400}'
        )
      ).toBe(false)
      expect(isValidBanDurationsJSON('[900, 21600]')).toBe(false)
    })
  })

  describe('isValidHeuristicsJSON', () => {
    it('accepts empty and an object of overrides', () => {
      expect(isValidHeuristicsJSON('')).toBe(true)
      expect(isValidHeuristicsJSON('{"ssh_fail_threshold": 5}')).toBe(true)
    })

    it('rejects non-objects and malformed JSON', () => {
      expect(isValidHeuristicsJSON('[1, 2]')).toBe(false)
      expect(isValidHeuristicsJSON('5')).toBe(false)
      expect(isValidHeuristicsJSON('{"ssh_fail_threshold": }')).toBe(false)
    })
  })
})