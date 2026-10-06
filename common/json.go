package common

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"strings"
)

func Unmarshal(data []byte, v any) error {
	return json.Unmarshal(data, v)
}

func UnmarshalJsonStr(data string, v any) error {
	return json.Unmarshal(StringToByteSlice(data), v)
}

func DecodeJson(reader io.Reader, v any) error {
	return json.NewDecoder(reader).Decode(v)
}

func DecodeJsonStrict(reader io.Reader, v any) error {
	decoder := json.NewDecoder(reader)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(v); err != nil {
		return err
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		if err == nil {
			return errors.New("unexpected trailing JSON value")
		}
		return err
	}
	return nil
}

func Marshal(v any) ([]byte, error) {
	return json.Marshal(v)
}

func IndentJson(data []byte) ([]byte, error) {
	var buffer bytes.Buffer
	if err := json.Indent(&buffer, data, "", "  "); err != nil {
		return nil, err
	}
	return buffer.Bytes(), nil
}

func GetJsonType(data json.RawMessage) string {
	trimmed := bytes.TrimSpace(data)
	if len(trimmed) == 0 {
		return "unknown"
	}
	firstChar := trimmed[0]
	switch firstChar {
	case '{':
		return "object"
	case '[':
		return "array"
	case '"':
		return "string"
	case 't', 'f':
		return "boolean"
	case 'n':
		return "null"
	default:
		return "number"
	}
}

// JsonRawMessageToString returns JSON strings as their decoded value and other JSON values as raw text.
func JsonRawMessageToString(data json.RawMessage) string {
	trimmed := bytes.TrimSpace(data)
	if len(trimmed) == 0 || bytes.Equal(trimmed, []byte("null")) {
		return ""
	}
	if trimmed[0] != '"' {
		return string(trimmed)
	}
	var value string
	if err := Unmarshal(trimmed, &value); err != nil {
		return string(trimmed)
	}
	return value
}

// DecodeJsonObjectStrict rejects duplicate keys and non-object top-level input,
// in addition to unknown fields and trailing JSON. Callers must bound reader.
func DecodeJsonObjectStrict(reader io.Reader, v any) error {
	data, err := io.ReadAll(reader)
	if err != nil {
		return err
	}
	scan := json.NewDecoder(bytes.NewReader(data))
	first, err := scan.Token()
	if err != nil || first != json.Delim('{') {
		return errors.New("expected JSON object")
	}
	var object func() error
	var value func(json.Token) error
	value = func(token json.Token) error {
		switch token {
		case json.Delim('{'):
			return object()
		case json.Delim('['):
			for scan.More() {
				t, e := scan.Token()
				if e != nil {
					return e
				}
				if e = value(t); e != nil {
					return e
				}
			}
			end, e := scan.Token()
			if e != nil {
				return e
			}
			if end != json.Delim(']') {
				return errors.New("invalid JSON array")
			}
		}
		return nil
	}
	object = func() error {
		keys := map[string]bool{}
		for scan.More() {
			token, e := scan.Token()
			if e != nil {
				return e
			}
			key, ok := token.(string)
			key = strings.ToLower(key) // Struct field matching is case-insensitive.
			if !ok || keys[key] {
				return errors.New("invalid or duplicate JSON key")
			}
			keys[key] = true
			token, e = scan.Token()
			if e != nil {
				return e
			}
			if e = value(token); e != nil {
				return e
			}
		}
		end, e := scan.Token()
		if e != nil {
			return e
		}
		if end != json.Delim('}') {
			return errors.New("invalid JSON object")
		}
		return nil
	}
	if err = object(); err != nil {
		return err
	}
	return DecodeJsonStrict(bytes.NewReader(data), v)
}
