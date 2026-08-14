package common

import (
	"net"
	"os"
	"strings"
	"sync"

	"github.com/oschwald/geoip2-golang"
)

// GeoIP 地区查询封装:按请求 IP 查 Country.mmdb 得到 ISO 国家码,
// 供公开接口 GET /api/geo/check 判断是否弹出地区访问提醒(只提醒不拦截)。
// 路径解析与 service/appCenterGeoIPDatabasePath 保持一致:
// APP_CENTER_GEOIP_DB 环境变量 → /data/app-center/Country.mmdb → /root/clash-for-linux-install/resources/Country.mmdb

var (
	geoIPMu       sync.Mutex
	geoIPReader   *geoip2.Reader
	geoIPLoadedDB string
)

func geoIPDatabasePath() string {
	if path := strings.TrimSpace(os.Getenv("APP_CENTER_GEOIP_DB")); path != "" {
		return path
	}
	if _, err := os.Stat("/data/app-center/Country.mmdb"); err == nil {
		return "/data/app-center/Country.mmdb"
	}
	return "/root/clash-for-linux-install/resources/Country.mmdb"
}

// LookupCountryCode 返回 ip 对应的 ISO 国家码。
// ip 为 nil、数据库未加载或查询失败时返回空字符串与 false。
// 先用 reader.Country(ip) 查询;若失败(例如 Country 库不支持 Country 方法的极端情况)
// 再降级用 reader.City(ip) 取 Country.IsoCode(City 库包含 Country 记录)。
// 幂等、并发安全:整个加载与查询过程都在同一把 mutex 下完成。
func LookupCountryCode(ip net.IP) (isoCode string, ok bool) {
	if ip == nil {
		return "", false
	}
	path := geoIPDatabasePath()
	geoIPMu.Lock()
	defer geoIPMu.Unlock()
	if geoIPLoadedDB != path {
		if geoIPReader != nil {
			_ = geoIPReader.Close()
		}
		geoIPReader = nil
		geoIPLoadedDB = path
		reader, err := geoip2.Open(path)
		if err != nil {
			SysError("failed to open GeoIP database " + path + ": " + err.Error())
			return "", false
		}
		geoIPReader = reader
	}
	if geoIPReader == nil {
		return "", false
	}
	if record, err := geoIPReader.Country(ip); err == nil && record.Country.IsoCode != "" {
		return record.Country.IsoCode, true
	}
	if record, err := geoIPReader.City(ip); err == nil && record.Country.IsoCode != "" {
		return record.Country.IsoCode, true
	}
	return "", false
}
