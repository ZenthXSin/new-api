// Package networktraffic runs bounded, opt-in background transfers without
// receiving API bodies, files, credentials, or any other user content.
package networktraffic

import (
	"errors"
	"fmt"
	"math"
	"os"
	"strconv"
	"time"

	"github.com/QuantumNous/new-api/common"
)

const EnabledOption = "NetworkTrafficEnabled"
const BudgetOption = "NetworkTrafficDailyBudgetGB"

// ValidateOption is shared by the administrator API and the runtime loader.
func ValidateOption(key, value string) error {
	switch key {
	case EnabledOption:
		if value != "true" && value != "false" {
			return errors.New("NetworkTrafficEnabled must be true or false")
		}
	case BudgetOption:
		gb, err := strconv.ParseFloat(value, 64)
		if err != nil || math.IsNaN(gb) || math.IsInf(gb, 0) || gb < 0.1 || gb > 5 {
			return errors.New("NetworkTrafficDailyBudgetGB must be between 0.1 and 5")
		}
	}
	return nil
}

type Config struct {
	Enabled             bool     `json:"enabled"`
	DailyBudgetBytes    int64    `json:"daily_budget_bytes"`
	MinCooldownSeconds  int      `json:"min_cooldown_seconds"`
	MaxCooldownSeconds  int      `json:"max_cooldown_seconds"`
	MinDelaySeconds     int      `json:"min_delay_seconds"`
	MaxDelaySeconds     int      `json:"max_delay_seconds"`
	MinRequestThreshold int      `json:"min_request_threshold"`
	MaxRequestThreshold int      `json:"max_request_threshold"`
	MinTriggerPercent   int      `json:"min_trigger_percent"`
	MaxTriggerPercent   int      `json:"max_trigger_percent"`
	MinDownloadBytes    int64    `json:"min_download_bytes"`
	MaxDownloadBytes    int64    `json:"max_download_bytes"`
	MinBytesPerSecond   int64    `json:"min_bytes_per_second"`
	MaxBytesPerSecond   int64    `json:"max_bytes_per_second"`
	Sources             []string `json:"sources"`
}

func DefaultConfig() Config {
	return Config{
		DailyBudgetBytes:   5_000_000_000,
		MinCooldownSeconds: 90, MaxCooldownSeconds: 360,
		MinDelaySeconds: 5, MaxDelaySeconds: 45,
		MinRequestThreshold: 2, MaxRequestThreshold: 10,
		MinTriggerPercent: 15, MaxTriggerPercent: 45,
		MinDownloadBytes: 1 << 20, MaxDownloadBytes: 24 << 20,
		MinBytesPerSecond: 64 << 10, MaxBytesPerSecond: 512 << 10,
		Sources: []string{"cloudflare_download", "github_archive", "docker_official", "docker_aliyun", "cloudflare_upload"},
	}
}

func readConfig(path string) (Config, error) {
	config := DefaultConfig()
	file, err := os.Open(path)
	if err != nil {
		return config, err
	}
	defer file.Close()
	stat, err := file.Stat()
	if err != nil {
		return config, err
	}
	if stat.Size() > 16<<10 {
		return config, errors.New("network traffic configuration is too large")
	}
	if err := common.DecodeJson(file, &config); err != nil {
		return config, err
	}
	common.OptionMapRWMutex.RLock()
	enabled, budget := common.OptionMap[EnabledOption], common.OptionMap[BudgetOption]
	common.OptionMapRWMutex.RUnlock()
	if enabled == "" {
		enabled = "false"
	}
	if budget == "" {
		budget = "5"
	}
	if err := ValidateOption(EnabledOption, enabled); err != nil {
		return config, err
	}
	if err := ValidateOption(BudgetOption, budget); err != nil {
		return config, err
	}
	gb, _ := strconv.ParseFloat(budget, 64)
	config.Enabled = config.Enabled && enabled == "true"
	config.DailyBudgetBytes = int64(gb * 1_000_000_000)
	return config, config.validate()
}

func (c Config) validate() error {
	if c.DailyBudgetBytes < 1<<20 || c.DailyBudgetBytes > 5_000_000_000 {
		return errors.New("daily budget must be between 1 MiB and 5 GB")
	}
	ranges := [][4]int64{
		{int64(c.MinCooldownSeconds), int64(c.MaxCooldownSeconds), 30, 3600},
		{int64(c.MinDelaySeconds), int64(c.MaxDelaySeconds), 1, 60},
		{int64(c.MinRequestThreshold), int64(c.MaxRequestThreshold), 2, 1000},
		{int64(c.MinTriggerPercent), int64(c.MaxTriggerPercent), 1, 90},
		{c.MinDownloadBytes, c.MaxDownloadBytes, 64 << 10, 24 << 20},
		{c.MinBytesPerSecond, c.MaxBytesPerSecond, 32 << 10, 1 << 20},
	}
	for _, values := range ranges {
		if values[0] < values[2] || values[1] > values[3] || values[0] > values[1] {
			return errors.New("invalid network traffic scheduling bounds")
		}
	}
	if len(c.Sources) == 0 || len(c.Sources) > len(sources) {
		return errors.New("at least one allowed source is required")
	}
	seen := make(map[string]bool)
	for _, name := range c.Sources {
		if _, ok := sources[name]; !ok || seen[name] {
			return fmt.Errorf("unknown or repeated network traffic source: %s", name)
		}
		seen[name] = true
	}
	return nil
}

type source struct {
	URLs   []string
	Weight int
	Upload bool
	Range  bool
}

// Only public, fixed HTTPS endpoints are eligible. There are no configurable
// arbitrary URLs, credentials, redirects, user-agent spoofing, or user files.
var sources = map[string]source{
	"cloudflare_download": {URLs: []string{"https://speed.cloudflare.com/__down"}, Weight: 50},
	"cloudflare_upload":   {URLs: []string{"https://speed.cloudflare.com/__up"}, Weight: 5, Upload: true},
	"github_archive": {
		URLs: []string{
			"https://codeload.github.com/git/git/tar.gz/refs/tags/v2.45.0",
			"https://codeload.github.com/docker/cli/tar.gz/refs/tags/v27.0.3",
		}, Weight: 15,
	},
	"docker_official": {URLs: []string{"https://download.docker.com/linux/static/stable/x86_64/docker-27.0.3.tgz"}, Weight: 15, Range: true},
	"docker_aliyun":   {URLs: []string{"https://mirrors.aliyun.com/docker-ce/linux/static/stable/x86_64/docker-27.0.3.tgz"}, Weight: 15, Range: true},
}

var budgetLocation = time.FixedZone("UTC+08", 8*60*60)

const activityTTL = 2 * time.Minute
