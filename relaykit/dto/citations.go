package dto

import (
	"net/url"
	"strings"

	kitutil "github.com/QuantumNous/new-api/relaykit/relayconvert/kitutil"
)

// ChatAnnotation is the Chat Completions citation shape. Only structured
// provider citations are converted; response text is never treated as a source.
type ChatAnnotation struct {
	Type        string       `json:"type"`
	URLCitation *URLCitation `json:"url_citation,omitempty"`
}

type URLCitation struct {
	URL        string `json:"url"`
	Title      string `json:"title"`
	StartIndex *int   `json:"start_index,omitempty"`
	EndIndex   *int   `json:"end_index,omitempty"`
}

func NewURLCitationAnnotation(rawURL, title string) *ChatAnnotation {
	rawURL = strings.TrimSpace(rawURL)
	u, err := url.Parse(rawURL)
	if err != nil || u.Hostname() == "" || u.User != nil || (u.Scheme != "https" && u.Scheme != "http") {
		return nil
	}
	return &ChatAnnotation{Type: "url_citation", URLCitation: &URLCitation{URL: rawURL, Title: title}}
}

// Responses annotations use flat fields. Offsets are intentionally omitted
// when normalizing because multiple provider text blocks may be concatenated.
func ResponsesURLCitations(annotations []any) []ChatAnnotation {
	var result []ChatAnnotation
	for _, value := range annotations {
		var citation struct {
			Type  string `json:"type"`
			URL   string `json:"url"`
			Title string `json:"title"`
		}
		data, err := kitutil.Marshal(value)
		if err != nil || kitutil.Unmarshal(data, &citation) != nil || citation.Type != "url_citation" {
			continue
		}
		if annotation := NewURLCitationAnnotation(citation.URL, citation.Title); annotation != nil {
			result = append(result, *annotation)
		}
	}
	return result
}
