package services

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// EconomicFeedsService provides free economic and market intelligence feeds
// Inspired by github.com/calesthio/Crucix — all sources are free, no API key required
type EconomicFeedsService struct {
	httpClient *http.Client
}

// NewEconomicFeedsService creates a new economic feeds service
func NewEconomicFeedsService() *EconomicFeedsService {
	return &EconomicFeedsService{
		httpClient: &http.Client{
			Timeout: 15 * time.Second,
		},
	}
}

// ── US Treasury ────────────────────────────────────────────────────────────────
// No auth required. Daily updates. National debt, interest rates.

// TreasuryDebtEntry represents a single debt-to-the-penny record
type TreasuryDebtEntry struct {
	Date         string `json:"record_date"`
	TotalDebt    string `json:"tot_pub_debt_out_amt"`
	PublicDebt   string `json:"debt_held_public_amt"`
	IntragovDebt string `json:"intragov_hold_amt"`
}

// TreasuryRateEntry represents an average interest rate record
type TreasuryRateEntry struct {
	Date         string `json:"record_date"`
	SecurityDesc string `json:"security_desc"`
	Rate         string `json:"avg_interest_rate_amt"`
}

// TreasuryBriefing is the combined treasury intelligence response
type TreasuryBriefing struct {
	Source        string              `json:"source"`
	Timestamp     string              `json:"timestamp"`
	Debt          []TreasuryDebtEntry `json:"debt"`
	InterestRates []TreasuryRateEntry `json:"interest_rates"`
	Signals       []string            `json:"signals"`
}

// GetTreasuryBriefing fetches national debt and interest rate data
func (s *EconomicFeedsService) GetTreasuryBriefing() (*TreasuryBriefing, error) {
	base := "https://api.fiscaldata.treasury.gov/services/api/fiscal_service"
	cutoff := time.Now().AddDate(0, 0, -30).Format("2006-01-02")

	// Fetch debt data
	debtURL := fmt.Sprintf("%s/v2/accounting/od/debt_to_penny?fields=record_date,tot_pub_debt_out_amt,intragov_hold_amt,debt_held_public_amt&sort=-record_date&page[size]=10&filter=record_date:gte:%s", base, cutoff)
	debtResp, err := s.fetchJSON(debtURL)
	if err != nil {
		return nil, fmt.Errorf("treasury debt: %w", err)
	}

	// Fetch interest rate data
	ratesURL := fmt.Sprintf("%s/v2/accounting/od/avg_interest_rates?fields=record_date,security_desc,avg_interest_rate_amt&sort=-record_date&page[size]=30&filter=record_date:gte:%s", base, cutoff)
	ratesResp, err := s.fetchJSON(ratesURL)
	if err != nil {
		return nil, fmt.Errorf("treasury rates: %w", err)
	}

	// Parse debt entries
	var debt []TreasuryDebtEntry
	if data, ok := debtResp["data"].([]interface{}); ok {
		for _, d := range data {
			if m, ok := d.(map[string]interface{}); ok {
				debt = append(debt, TreasuryDebtEntry{
					Date:         getString(m, "record_date"),
					TotalDebt:    getString(m, "tot_pub_debt_out_amt"),
					PublicDebt:   getString(m, "debt_held_public_amt"),
					IntragovDebt: getString(m, "intragov_hold_amt"),
				})
			}
		}
	}

	// Parse rate entries
	var rates []TreasuryRateEntry
	if data, ok := ratesResp["data"].([]interface{}); ok {
		for _, d := range data {
			if m, ok := d.(map[string]interface{}); ok {
				rates = append(rates, TreasuryRateEntry{
					Date:         getString(m, "record_date"),
					SecurityDesc: getString(m, "security_desc"),
					Rate:         getString(m, "avg_interest_rate_amt"),
				})
			}
		}
	}

	return &TreasuryBriefing{
		Source:        "US Treasury",
		Timestamp:     time.Now().UTC().Format(time.RFC3339),
		Debt:          debt,
		InterestRates: rates,
		Signals:       []string{},
	}, nil
}

// ── GDELT ──────────────────────────────────────────────────────────────────────
// No auth required. Updates every 15 minutes. Global news events with sentiment.

// GDELTArticle represents a single GDELT news article
type GDELTArticle struct {
	Title         string `json:"title"`
	URL           string `json:"url"`
	SeenDate      string `json:"seendate"`
	Domain        string `json:"domain"`
	Language      string `json:"language"`
	SourceCountry string `json:"sourcecountry"`
}

// GDELTBriefing is the combined GDELT intelligence response
type GDELTBriefing struct {
	Source        string         `json:"source"`
	Timestamp     string         `json:"timestamp"`
	TotalArticles int            `json:"total_articles"`
	Articles      []GDELTArticle `json:"articles"`
	Conflicts     []GDELTArticle `json:"conflicts"`
	Economy       []GDELTArticle `json:"economy"`
	Health        []GDELTArticle `json:"health"`
}

// GetGDELTBriefing fetches global event articles from GDELT
func (s *EconomicFeedsService) GetGDELTBriefing(query string) (*GDELTBriefing, error) {
	if query == "" {
		query = "economy OR market OR stocks OR tariff OR sanctions OR recession OR inflation OR interest rate OR federal reserve"
	}

	params := url.Values{
		"query":      {query},
		"mode":       {"ArtList"},
		"maxrecords": {"75"},
		"timespan":   {"24h"},
		"format":     {"json"},
		"sort":       {"DateDesc"},
	}

	apiURL := "https://api.gdeltproject.org/api/v2/doc/doc?" + params.Encode()
	resp, err := s.fetchJSON(apiURL)
	if err != nil {
		return nil, fmt.Errorf("gdelt: %w", err)
	}

	var articles []GDELTArticle
	if arts, ok := resp["articles"].([]interface{}); ok {
		for _, a := range arts {
			if m, ok := a.(map[string]interface{}); ok {
				articles = append(articles, GDELTArticle{
					Title:         getString(m, "title"),
					URL:           getString(m, "url"),
					SeenDate:      getString(m, "seendate"),
					Domain:        getString(m, "domain"),
					Language:      getString(m, "language"),
					SourceCountry: getString(m, "sourcecountry"),
				})
			}
		}
	}

	// Categorize by keyword matching
	conflicts := filterArticles(articles, []string{"military", "conflict", "war", "strike", "missile", "attack", "troops"})
	economy := filterArticles(articles, []string{"economy", "recession", "inflation", "market", "sanctions", "tariff", "trade", "gdp", "fed", "interest rate"})
	health := filterArticles(articles, []string{"pandemic", "outbreak", "epidemic", "disease", "virus"})

	return &GDELTBriefing{
		Source:        "GDELT",
		Timestamp:     time.Now().UTC().Format(time.RFC3339),
		TotalArticles: len(articles),
		Articles:      articles,
		Conflicts:     conflicts,
		Economy:       economy,
		Health:        health,
	}, nil
}

// ── BLS (Bureau of Labor Statistics) ───────────────────────────────────────────
// V1 API requires no key. CPI, unemployment, nonfarm payrolls.

// BLSIndicator represents a single economic indicator from BLS
type BLSIndicator struct {
	SeriesID string  `json:"series_id"`
	Label    string  `json:"label"`
	Value    float64 `json:"value"`
	Period   string  `json:"period"`
	Year     string  `json:"year"`
}

// BLSBriefing is the combined BLS economic data response
type BLSBriefing struct {
	Source     string         `json:"source"`
	Timestamp  string         `json:"timestamp"`
	Indicators []BLSIndicator `json:"indicators"`
	Signals    []string       `json:"signals"`
}

// BLS series IDs and their labels
var blsSeries = map[string]string{
	"CUUR0000SA0":    "CPI-U All Items",
	"CUUR0000SA0L1E": "CPI-U Core (ex Food & Energy)",
	"LNS14000000":    "Unemployment Rate",
	"CES0000000001":  "Nonfarm Payrolls (thousands)",
	"WPUFD49104":     "PPI Final Demand",
}

// GetBLSBriefing fetches key economic indicators from BLS
func (s *EconomicFeedsService) GetBLSBriefing() (*BLSBriefing, error) {
	seriesIDs := make([]string, 0, len(blsSeries))
	for id := range blsSeries {
		seriesIDs = append(seriesIDs, id)
	}

	now := time.Now()
	payload := map[string]interface{}{
		"seriesid":  seriesIDs,
		"startyear": fmt.Sprintf("%d", now.Year()-1),
		"endyear":   fmt.Sprintf("%d", now.Year()),
	}

	body, err := json.Marshal(payload)
	if err != nil {
		return nil, err
	}

	req, err := http.NewRequest("POST", "https://api.bls.gov/publicAPI/v1/timeseries/data/", strings.NewReader(string(body)))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := s.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("bls: %w", err)
	}
	defer resp.Body.Close()

	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}

	var result map[string]interface{}
	if err := json.Unmarshal(respBody, &result); err != nil {
		return nil, err
	}

	var indicators []BLSIndicator
	var signals []string

	if results, ok := result["Results"].(map[string]interface{}); ok {
		if series, ok := results["series"].([]interface{}); ok {
			for _, s := range series {
				sm, ok := s.(map[string]interface{})
				if !ok {
					continue
				}
				seriesID := getString(sm, "seriesID")
				label := blsSeries[seriesID]
				if label == "" {
					label = seriesID
				}

				data, ok := sm["data"].([]interface{})
				if !ok || len(data) == 0 {
					continue
				}

				// Get latest valid observation
				for _, d := range data {
					dm, ok := d.(map[string]interface{})
					if !ok {
						continue
					}
					valStr := getString(dm, "value")
					if valStr == "-" || valStr == "." || valStr == "" {
						continue
					}
					var val float64
					fmt.Sscanf(valStr, "%f", &val)

					indicators = append(indicators, BLSIndicator{
						SeriesID: seriesID,
						Label:    label,
						Value:    val,
						Period:   getString(dm, "period"),
						Year:     getString(dm, "year"),
					})

					// Generate signals
					if seriesID == "LNS14000000" && val > 5.0 {
						signals = append(signals, fmt.Sprintf("Unemployment elevated at %.1f%%", val))
					}
					break // only latest
				}
			}
		}
	}

	return &BLSBriefing{
		Source:     "BLS",
		Timestamp:  time.Now().UTC().Format(time.RFC3339),
		Indicators: indicators,
		Signals:    signals,
	}, nil
}

// ── Yahoo Finance ──────────────────────────────────────────────────────────────
// No API key required. Live market quotes for indexes, commodities, crypto, VIX.

// YFQuote represents a single Yahoo Finance quote
type YFQuote struct {
	Symbol    string  `json:"symbol"`
	Name      string  `json:"name"`
	Price     float64 `json:"price"`
	PrevClose float64 `json:"prev_close"`
	Change    float64 `json:"change"`
	ChangePct float64 `json:"change_pct"`
	Currency  string  `json:"currency"`
	Exchange  string  `json:"exchange"`
	History   []YFBar `json:"history,omitempty"`
}

// YFBar represents a single price bar
type YFBar struct {
	Date  string  `json:"date"`
	Close float64 `json:"close"`
}

// YFBriefing is the combined Yahoo Finance market snapshot
type YFBriefing struct {
	Source      string    `json:"source"`
	Timestamp   string    `json:"timestamp"`
	Indexes     []YFQuote `json:"indexes"`
	Rates       []YFQuote `json:"rates"`
	Commodities []YFQuote `json:"commodities"`
	Crypto      []YFQuote `json:"crypto"`
	Volatility  []YFQuote `json:"volatility"`
}

// Yahoo Finance symbol groups
var yfSymbols = map[string]map[string]string{
	"indexes": {
		"SPY": "S&P 500",
		"QQQ": "Nasdaq 100",
		"DIA": "Dow Jones",
		"IWM": "Russell 2000",
	},
	"rates": {
		"TLT": "20Y+ Treasury",
		"HYG": "High Yield Corp",
		"LQD": "IG Corporate",
	},
	"commodities": {
		"GC=F": "Gold",
		"SI=F": "Silver",
		"CL=F": "WTI Crude",
		"BZ=F": "Brent Crude",
		"NG=F": "Natural Gas",
	},
	"crypto": {
		"BTC-USD": "Bitcoin",
		"ETH-USD": "Ethereum",
	},
	"volatility": {
		"^VIX": "VIX",
	},
}

// GetYFinanceBriefing fetches a broad market snapshot from Yahoo Finance
func (s *EconomicFeedsService) GetYFinanceBriefing() (*YFBriefing, error) {
	briefing := &YFBriefing{
		Source:    "Yahoo Finance",
		Timestamp: time.Now().UTC().Format(time.RFC3339),
	}

	for group, symbols := range yfSymbols {
		for symbol, name := range symbols {
			quote, err := s.fetchYFQuote(symbol, name)
			if err != nil {
				continue
			}
			switch group {
			case "indexes":
				briefing.Indexes = append(briefing.Indexes, *quote)
			case "rates":
				briefing.Rates = append(briefing.Rates, *quote)
			case "commodities":
				briefing.Commodities = append(briefing.Commodities, *quote)
			case "crypto":
				briefing.Crypto = append(briefing.Crypto, *quote)
			case "volatility":
				briefing.Volatility = append(briefing.Volatility, *quote)
			}
		}
	}

	return briefing, nil
}

func (s *EconomicFeedsService) fetchYFQuote(symbol, name string) (*YFQuote, error) {
	apiURL := fmt.Sprintf("https://query1.finance.yahoo.com/v8/finance/chart/%s?range=5d&interval=1d&includePrePost=false", url.PathEscape(symbol))

	req, err := http.NewRequest("GET", apiURL, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36")

	resp, err := s.httpClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}

	var data map[string]interface{}
	if err := json.Unmarshal(body, &data); err != nil {
		return nil, err
	}

	// Navigate: chart.result[0]
	chart, _ := data["chart"].(map[string]interface{})
	if chart == nil {
		return nil, fmt.Errorf("no chart data for %s", symbol)
	}
	results, _ := chart["result"].([]interface{})
	if len(results) == 0 {
		return nil, fmt.Errorf("no results for %s", symbol)
	}
	result, _ := results[0].(map[string]interface{})
	if result == nil {
		return nil, fmt.Errorf("invalid result for %s", symbol)
	}

	meta, _ := result["meta"].(map[string]interface{})
	if meta == nil {
		return nil, fmt.Errorf("no meta for %s", symbol)
	}

	price := getFloat(meta, "regularMarketPrice")
	prevClose := getFloat(meta, "chartPreviousClose")
	if prevClose == 0 {
		prevClose = getFloat(meta, "previousClose")
	}

	change := price - prevClose
	changePct := 0.0
	if prevClose != 0 {
		changePct = (change / prevClose) * 100
	}

	// Build 5-day history
	var history []YFBar
	if timestamps, ok := result["timestamp"].([]interface{}); ok {
		indicators, _ := result["indicators"].(map[string]interface{})
		if indicators != nil {
			quotes, _ := indicators["quote"].([]interface{})
			if len(quotes) > 0 {
				q, _ := quotes[0].(map[string]interface{})
				closes, _ := q["close"].([]interface{})
				for i, ts := range timestamps {
					if i < len(closes) && closes[i] != nil {
						tsFloat, _ := ts.(float64)
						closeFloat, _ := closes[i].(float64)
						t := time.Unix(int64(tsFloat), 0)
						history = append(history, YFBar{
							Date:  t.Format("2006-01-02"),
							Close: float64(int(closeFloat*100)) / 100,
						})
					}
				}
			}
		}
	}

	return &YFQuote{
		Symbol:    symbol,
		Name:      name,
		Price:     float64(int(price*100)) / 100,
		PrevClose: float64(int(prevClose*100)) / 100,
		Change:    float64(int(change*100)) / 100,
		ChangePct: float64(int(changePct*100)) / 100,
		Currency:  getString(meta, "currency"),
		Exchange:  getString(meta, "exchangeName"),
		History:   history,
	}, nil
}

// ── USAspending ────────────────────────────────────────────────────────────────
// No auth required. Federal spending and defense contracts.

// USASpendingContract represents a government contract award
type USASpendingContract struct {
	AwardID     string  `json:"award_id"`
	Recipient   string  `json:"recipient"`
	Amount      float64 `json:"amount"`
	Description string  `json:"description"`
	Agency      string  `json:"agency"`
	Date        string  `json:"date"`
	Type        string  `json:"type"`
}

// USASpendingBriefing is the combined USAspending response
type USASpendingBriefing struct {
	Source    string                `json:"source"`
	Timestamp string                `json:"timestamp"`
	Contracts []USASpendingContract `json:"recent_defense_contracts"`
}

// GetUSASpendingBriefing fetches recent defense contract data
func (s *EconomicFeedsService) GetUSASpendingBriefing() (*USASpendingBriefing, error) {
	cutoff := time.Now().AddDate(0, 0, -14).Format("2006-01-02")
	today := time.Now().Format("2006-01-02")

	payload := map[string]interface{}{
		"filters": map[string]interface{}{
			"keywords":         []string{"defense", "military", "missile", "ammunition", "aircraft", "naval"},
			"time_period":      []map[string]string{{"start_date": cutoff, "end_date": today}},
			"award_type_codes": []string{"A", "B", "C", "D"},
		},
		"fields": []string{"Award ID", "Recipient Name", "Award Amount", "Description", "Awarding Agency", "Start Date", "Award Type"},
		"limit":  20,
		"page":   1,
		"sort":   "Award Amount",
		"order":  "desc",
	}

	body, err := json.Marshal(payload)
	if err != nil {
		return nil, err
	}

	req, err := http.NewRequest("POST", "https://api.usaspending.gov/api/v2/search/spending_by_award/", strings.NewReader(string(body)))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := s.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("usaspending: %w", err)
	}
	defer resp.Body.Close()

	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}

	var result map[string]interface{}
	if err := json.Unmarshal(respBody, &result); err != nil {
		return nil, err
	}

	var contracts []USASpendingContract
	if results, ok := result["results"].([]interface{}); ok {
		for _, r := range results {
			if m, ok := r.(map[string]interface{}); ok {
				contracts = append(contracts, USASpendingContract{
					AwardID:     getString(m, "Award ID"),
					Recipient:   getString(m, "Recipient Name"),
					Amount:      getFloat(m, "Award Amount"),
					Description: getString(m, "Description"),
					Agency:      getString(m, "Awarding Agency"),
					Date:        getString(m, "Start Date"),
					Type:        getString(m, "Award Type"),
				})
			}
		}
	}

	return &USASpendingBriefing{
		Source:    "USAspending",
		Timestamp: time.Now().UTC().Format(time.RFC3339),
		Contracts: contracts,
	}, nil
}

// ── UN Comtrade ────────────────────────────────────────────────────────────────
// Public preview endpoint requires no key. Global trade flows.

// ComtradeFlow represents a single trade flow record
type ComtradeFlow struct {
	Reporter  string  `json:"reporter"`
	Partner   string  `json:"partner"`
	Commodity string  `json:"commodity"`
	Flow      string  `json:"flow"`
	Value     float64 `json:"value"`
	Period    string  `json:"period"`
}

// ComtradeBriefing is the combined UN Comtrade response
type ComtradeBriefing struct {
	Source     string         `json:"source"`
	Timestamp  string         `json:"timestamp"`
	TradeFlows []ComtradeFlow `json:"trade_flows"`
	Signals    []string       `json:"signals"`
	Note       string         `json:"note"`
}

// Strategic commodity codes (HS classification)
var strategicCommodities = map[string]string{
	"2709": "Crude Petroleum",
	"2711": "Natural Gas",
	"7108": "Gold",
	"8542": "Semiconductors",
}

// GetComtradeBriefing fetches key commodity trade flow data
func (s *EconomicFeedsService) GetComtradeBriefing() (*ComtradeBriefing, error) {
	year := time.Now().Year()
	var allFlows []ComtradeFlow

	// US imports of strategic commodities
	for code, name := range strategicCommodities {
		params := url.Values{
			"reporterCode": {"842"}, // US
			"period":       {fmt.Sprintf("%d", year)},
			"cmdCode":      {code},
			"flowCode":     {"M"}, // imports
		}

		apiURL := "https://comtradeapi.un.org/public/v1/preview/C/A/HS?" + params.Encode()
		resp, err := s.fetchJSONWithTimeout(apiURL, 20*time.Second)
		if err != nil {
			// Try previous year
			params.Set("period", fmt.Sprintf("%d", year-1))
			apiURL = "https://comtradeapi.un.org/public/v1/preview/C/A/HS?" + params.Encode()
			resp, err = s.fetchJSONWithTimeout(apiURL, 20*time.Second)
			if err != nil {
				continue
			}
		}

		if data, ok := resp["data"].([]interface{}); ok {
			for _, d := range data {
				if m, ok := d.(map[string]interface{}); ok {
					allFlows = append(allFlows, ComtradeFlow{
						Reporter:  getString(m, "reporterDesc"),
						Partner:   getString(m, "partnerDesc"),
						Commodity: name,
						Flow:      getString(m, "flowDesc"),
						Value:     getFloat(m, "primaryValue"),
						Period:    getString(m, "period"),
					})
				}
			}
		}
	}

	return &ComtradeBriefing{
		Source:     "UN Comtrade",
		Timestamp:  time.Now().UTC().Format(time.RFC3339),
		TradeFlows: allFlows,
		Signals:    []string{},
		Note:       "Comtrade data often lags 1-2 months. Recent periods may be incomplete.",
	}, nil
}

// ── Helpers ────────────────────────────────────────────────────────────────────

func (s *EconomicFeedsService) fetchJSON(apiURL string) (map[string]interface{}, error) {
	return s.fetchJSONWithTimeout(apiURL, 0)
}

func (s *EconomicFeedsService) fetchJSONWithTimeout(apiURL string, timeout time.Duration) (map[string]interface{}, error) {
	client := s.httpClient
	if timeout > 0 {
		client = &http.Client{Timeout: timeout}
	}

	resp, err := client.Get(apiURL)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("HTTP %d from %s", resp.StatusCode, apiURL)
	}

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}

	var result map[string]interface{}
	if err := json.Unmarshal(body, &result); err != nil {
		return nil, err
	}

	return result, nil
}

func getString(m map[string]interface{}, key string) string {
	if v, ok := m[key]; ok && v != nil {
		return fmt.Sprintf("%v", v)
	}
	return ""
}

func getFloat(m map[string]interface{}, key string) float64 {
	if v, ok := m[key]; ok {
		switch n := v.(type) {
		case float64:
			return n
		case int:
			return float64(n)
		case string:
			var f float64
			fmt.Sscanf(n, "%f", &f)
			return f
		}
	}
	return 0
}

func filterArticles(articles []GDELTArticle, keywords []string) []GDELTArticle {
	var result []GDELTArticle
	for _, a := range articles {
		title := strings.ToLower(a.Title)
		for _, kw := range keywords {
			if strings.Contains(title, kw) {
				result = append(result, a)
				break
			}
		}
	}
	return result
}
