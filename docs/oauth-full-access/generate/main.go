// Copyright (C) 2026 QuantumNous and contributors.
// SPDX-License-Identifier: AGPL-3.0-or-later
// Run from the repository root: go run ./docs/oauth-full-access/generate
package main

import (
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/QuantumNous/new-api/common"
	_ "github.com/QuantumNous/new-api/controller" // Registers the fixed hosted operation catalog; does not connect to a database.
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/service"
)

func main() {
	output := flag.String("output", "docs/oauth-full-access", "Output directory")
	flag.Parse()
	if err := generate(*output); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func writeJSON(directory, name string, value interface{}) error {
	data, err := common.Marshal(value)
	if err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(directory, name), append(data, '\n'), 0644)
}

func generate(directory string) error {
	if err := os.MkdirAll(directory, 0755); err != nil {
		return err
	}
	routes := service.OAuthRouteCatalog()
	sort.Slice(routes, func(i, j int) bool {
		return routes[i].Path+" "+routes[i].Method < routes[j].Path+" "+routes[j].Method
	})
	capabilities := model.OAuthCapabilities()
	modeCounts := map[string]int{}
	paths := map[string]interface{}{}
	scopes := map[string]string{}
	for _, capability := range capabilities {
		scopes[capability.Scope] = capability.Description
	}
	var markdown strings.Builder
	markdown.WriteString("# OAuth 路由授权目录\n\n此文件由当前 Go 授权目录生成。它证明每条登记路由的授权分类，不代表每种业务参数已执行端到端测试。现有角色、对象归属及细分权限继续生效。\n\n")
	markdown.WriteString("| 方法 | 路由 | scope | 模式 | 最低角色 |\n| --- | --- | --- | --- | --- |\n")
	for _, route := range routes {
		modeCounts[route.Mode]++
		path := route.Path
		parameters := make([]interface{}, 0)
		segments := strings.Split(path, "/")
		for index, segment := range segments {
			if strings.HasPrefix(segment, ":") || strings.HasPrefix(segment, "*") {
				name := segment[1:]
				segments[index] = "{" + name + "}"
				parameter := map[string]interface{}{"name": name, "in": "path", "required": true, "schema": map[string]string{"type": "string"}}
				if strings.HasPrefix(segment, "*") {
					parameter["x-gin-catch-all"] = true
				}
				parameters = append(parameters, parameter)
			}
		}
		path = strings.Join(segments, "/")
		item, ok := paths[path].(map[string]interface{})
		if !ok {
			item = map[string]interface{}{}
			paths[path] = item
		}
		operation := map[string]interface{}{
			"summary":         route.Description,
			"description":     "Authorization catalog entry. Existing business payload schemas are documented separately in docs/openapi/api.json and docs/openapi/relay.json. The original Gin route and delegation mode are authoritative. Hosted and protocol modes do not accept an ordinary delegated bearer token directly.",
			"x-new-api-scope": route.Scope, "x-new-api-resource": route.Resource,
			"x-new-api-mode": route.Mode, "x-new-api-min-role": route.MinRole,
			"x-new-api-gin-path": route.Path, "x-payload-schema-status": "not-expanded-in-authorization-index",
			"parameters": parameters,
			"responses":  map[string]interface{}{"default": map[string]string{"description": "Original business response; inspect the corresponding existing API schema and handler."}},
		}
		if route.Mode == service.OAuthRouteDirect || route.Mode == service.OAuthRouteCompatibility {
			requiredScopes := []string{}
			if route.Scope != "" {
				requiredScopes = append(requiredScopes, route.Scope)
			}
			operation["security"] = []interface{}{map[string]interface{}{"NewAPIOAuth": requiredScopes}}
		} else {
			operation["security"] = []interface{}{}
			operation["x-new-api-original-authentication-required"] = route.Mode != service.OAuthRoutePublic
		}
		item[strings.ToLower(route.Method)] = operation
		fmt.Fprintf(&markdown, "| %s | `%s` | `%s` | %s | %d |\n", route.Method, route.Path, route.Scope, route.Mode, route.MinRole)
	}
	catalog := map[string]interface{}{"catalog_version": service.OAuthCatalogVersion, "route_count": len(routes), "mode_counts": modeCounts, "routes": routes}
	if err := writeJSON(directory, "routes.json", catalog); err != nil {
		return err
	}
	if err := writeJSON(directory, "capabilities.json", map[string]interface{}{"catalog_version": service.OAuthCatalogVersion, "capabilities": capabilities}); err != nil {
		return err
	}
	if err := writeJSON(directory, "actions.json", map[string]interface{}{"catalog_version": service.OAuthCatalogVersion, "operations": service.OAuthActionOperations()}); err != nil {
		return err
	}
	document := map[string]interface{}{
		"openapi":               "3.0.3",
		"info":                  map[string]string{"title": "New API OAuth authorization index", "version": service.OAuthCatalogVersion, "description": "Complete delegation-policy index for registered application routes. This is an authorization index, not a generated complete business DTO schema. Public, hosted and protocol endpoints preserve their original authentication requirements."},
		"servers":               []interface{}{map[string]string{"url": "https://your-new-api.example", "description": "Replace with your own New API origin"}},
		"paths":                 paths,
		"components":            map[string]interface{}{"securitySchemes": map[string]interface{}{"NewAPIOAuth": map[string]interface{}{"type": "oauth2", "flows": map[string]interface{}{"authorizationCode": map[string]interface{}{"authorizationUrl": "/oidc/authorize", "tokenUrl": "/oidc/token", "refreshUrl": "/oidc/token", "scopes": scopes}}}}},
		"x-new-api-route-count": len(routes), "x-new-api-mode-counts": modeCounts,
	}
	if err := writeJSON(directory, "openapi.authorization.json", document); err != nil {
		return err
	}
	if err := os.WriteFile(filepath.Join(directory, "routes.md"), []byte(markdown.String()), 0644); err != nil {
		return err
	}
	fmt.Printf("Generated %d route policies and %d capabilities in %s\n", len(routes), len(capabilities), directory)
	return nil
}
