package common

import (
	"github.com/stretchr/testify/assert"
	"strings"
	"testing"
)

func TestDecodeJsonObjectStrictRejectsAmbiguousPaymentObjects(t *testing.T) {
	var out struct {
		Amount int            `json:"amount"`
		Meta   map[string]any `json:"meta"`
	}
	for _, raw := range []string{`null`, `[]`, `{"amount":1,"amount":2}`, `{"amount":1,"Amount":2}`, `{"amount":1,"\u0061mount":2}`, `{"meta":{"x":1,"x":2}}`, `{"meta":{"x":[{"a":1,"a":2}]}}`, `{"amount":1} {}`, `{"unknown":1}`, `{"amount":1.5}`} {
		assert.Error(t, DecodeJsonObjectStrict(strings.NewReader(raw), &out), raw)
	}
	assert.NoError(t, DecodeJsonObjectStrict(strings.NewReader(`{"amount":1,"meta":{"items":[{"x":1},{"x":2}]}}`), &out))
}
