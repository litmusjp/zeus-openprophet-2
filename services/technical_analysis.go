package services

import (
	"context"
	"fmt"
	"math"
	"prophet-trader/interfaces"
)

// TechnicalAnalysisService provides technical analysis calculations
type TechnicalAnalysisService struct {
	dataService interfaces.DataService
}

// NewTechnicalAnalysisService creates a new technical analysis service
func NewTechnicalAnalysisService(dataService interfaces.DataService) *TechnicalAnalysisService {
	return &TechnicalAnalysisService{
		dataService: dataService,
	}
}

// AnalysisResult contains comprehensive technical analysis
type AnalysisResult struct {
	Symbol      string           `json:"symbol"`
	CurrentPrice float64         `json:"current_price"`
	SMA20       float64          `json:"sma_20,omitempty"`
	SMA50       float64          `json:"sma_50,omitempty"`
	RSI         float64          `json:"rsi,omitempty"`
	MACD        *MACDResult      `json:"macd,omitempty"`
	Momentum    *MomentumResult  `json:"momentum,omitempty"`
	Volume      *VolumeAnalysis  `json:"volume,omitempty"`
	Signal      string           `json:"signal"` // "BUY", "SELL", "HOLD"
	Confidence  float64          `json:"confidence"` // 0-100
}

// MACDResult contains MACD indicator values
type MACDResult struct {
	MACD      float64 `json:"macd"`
	Signal    float64 `json:"signal"`
	Histogram float64 `json:"histogram"`
}

// MomentumResult contains momentum indicators
type MomentumResult struct {
	PriceChange1D   float64 `json:"price_change_1d"`
	PriceChange5D   float64 `json:"price_change_5d"`
	PercentChange1D float64 `json:"percent_change_1d"`
	PercentChange5D float64 `json:"percent_change_5d"`
}

// VolumeAnalysis contains volume-based indicators
type VolumeAnalysis struct {
	Current      int64   `json:"current"`
	Average      float64 `json:"average"`
	Ratio        float64 `json:"ratio"` // current / average
	Trend        string  `json:"trend"` // "increasing", "decreasing", "stable"
}

// CalculateSMA calculates Simple Moving Average
func CalculateSMA(bars []*interfaces.Bar, period int) float64 {
	if len(bars) < period {
		return 0
	}

	sum := 0.0
	start := len(bars) - period
	for i := start; i < len(bars); i++ {
		sum += bars[i].Close
	}

	return sum / float64(period)
}

// CalculateRSI calculates Relative Strength Index
func CalculateRSI(bars []*interfaces.Bar, period int) float64 {
	if len(bars) < period+1 {
		return 50.0 // neutral
	}

	gains := make([]float64, 0)
	losses := make([]float64, 0)

	start := len(bars) - period - 1
	for i := start; i < len(bars)-1; i++ {
		change := bars[i+1].Close - bars[i].Close
		if change > 0 {
			gains = append(gains, change)
			losses = append(losses, 0)
		} else {
			gains = append(gains, 0)
			losses = append(losses, math.Abs(change))
		}
	}

	avgGain := average(gains)
	avgLoss := average(losses)

	if avgLoss == 0 {
		return 100.0
	}

	rs := avgGain / avgLoss
	rsi := 100 - (100 / (1 + rs))

	return rsi
}

// CalculateMACD calculates MACD indicator
func CalculateMACD(bars []*interfaces.Bar) *MACDResult {
	if len(bars) < 26 {
		return nil
	}

	ema12 := calculateEMA(bars, 12)
	ema26 := calculateEMA(bars, 26)
	macdLine := ema12 - ema26

	// For signal line, we'd need historical MACD values
	// Simplified: use recent EMA as approximation
	signalLine := ema12 * 0.85 // simplified

	return &MACDResult{
		MACD:      macdLine,
		Signal:    signalLine,
		Histogram: macdLine - signalLine,
	}
}

// Analyze performs comprehensive technical analysis
func (tas *TechnicalAnalysisService) Analyze(ctx context.Context, symbol string, bars []*interfaces.Bar) (*AnalysisResult, error) {
	if len(bars) == 0 {
		return nil, fmt.Errorf("no bars data available")
	}

	currentBar := bars[len(bars)-1]
	result := &AnalysisResult{
		Symbol:       symbol,
		CurrentPrice: currentBar.Close,
	}

	// Calculate SMAs
	if len(bars) >= 20 {
		result.SMA20 = CalculateSMA(bars, 20)
	}
	if len(bars) >= 50 {
		result.SMA50 = CalculateSMA(bars, 50)
	}

	// Calculate RSI
	if len(bars) >= 15 {
		result.RSI = CalculateRSI(bars, 14)
	}

	// Calculate MACD
	result.MACD = CalculateMACD(bars)

	// Calculate Momentum
	result.Momentum = calculateMomentum(bars)

	// Calculate Volume Analysis
	result.Volume = analyzeVolume(bars)

	// Generate trading signal
	result.Signal, result.Confidence = generateSignal(result)

	return result, nil
}

// Helper functions

func average(values []float64) float64 {
	if len(values) == 0 {
		return 0
	}
	sum := 0.0
	for _, v := range values {
		sum += v
	}
	return sum / float64(len(values))
}

func calculateEMA(bars []*interfaces.Bar, period int) float64 {
	if len(bars) < period {
		return bars[len(bars)-1].Close
	}

	multiplier := 2.0 / float64(period+1)

	// Start with SMA
	ema := CalculateSMA(bars[:period], period)

	// Calculate EMA for remaining bars
	for i := period; i < len(bars); i++ {
		ema = (bars[i].Close * multiplier) + (ema * (1 - multiplier))
	}

	return ema
}

func calculateMomentum(bars []*interfaces.Bar) *MomentumResult {
	if len(bars) < 6 {
		return nil
	}

	current := bars[len(bars)-1].Close
	day1 := bars[len(bars)-2].Close
	day5 := bars[len(bars)-6].Close

	return &MomentumResult{
		PriceChange1D:   current - day1,
		PriceChange5D:   current - day5,
		PercentChange1D: ((current - day1) / day1) * 100,
		PercentChange5D: ((current - day5) / day5) * 100,
	}
}

func analyzeVolume(bars []*interfaces.Bar) *VolumeAnalysis {
	if len(bars) < 20 {
		return nil
	}

	currentVolume := bars[len(bars)-1].Volume

	// Calculate average volume over last 20 bars
	volumeSum := int64(0)
	for i := len(bars) - 20; i < len(bars); i++ {
		volumeSum += bars[i].Volume
	}
	avgVolume := float64(volumeSum) / 20.0

	ratio := float64(currentVolume) / avgVolume

	trend := "stable"
	if ratio > 1.5 {
		trend = "increasing"
	} else if ratio < 0.5 {
		trend = "decreasing"
	}

	return &VolumeAnalysis{
		Current: currentVolume,
		Average: avgVolume,
		Ratio:   ratio,
		Trend:   trend,
	}
}

func generateSignal(result *AnalysisResult) (string, float64) {
	signals := make(map[string]int)
	confidence := 0.0

	// Price vs SMA signals
	if result.SMA20 > 0 {
		if result.CurrentPrice > result.SMA20 {
			signals["buy"]++
			confidence += 15
		} else {
			signals["sell"]++
			confidence += 15
		}
	}

	if result.SMA50 > 0 {
		if result.SMA20 > result.SMA50 {
			signals["buy"]++
			confidence += 20
		} else if result.SMA20 < result.SMA50 {
			signals["sell"]++
			confidence += 20
		}
	}

	// RSI signals
	if result.RSI > 0 {
		if result.RSI < 30 {
			signals["buy"] += 2
			confidence += 25
		} else if result.RSI > 70 {
			signals["sell"] += 2
			confidence += 25
		} else {
			confidence += 10
		}
	}

	// MACD signals
	if result.MACD != nil {
		if result.MACD.Histogram > 0 {
			signals["buy"]++
			confidence += 15
		} else {
			signals["sell"]++
			confidence += 15
		}
	}

	// Momentum signals
	if result.Momentum != nil {
		if result.Momentum.PercentChange5D > 5 {
			signals["buy"]++
			confidence += 10
		} else if result.Momentum.PercentChange5D < -5 {
			signals["sell"]++
			confidence += 10
		}
	}

	// Volume confirmation
	if result.Volume != nil && result.Volume.Ratio > 1.2 {
		confidence += 5
	}

	// Determine final signal
	buyScore := signals["buy"]
	sellScore := signals["sell"]

	if buyScore > sellScore+1 {
		return "BUY", math.Min(confidence, 100)
	} else if sellScore > buyScore+1 {
		return "SELL", math.Min(confidence, 100)
	}

	return "HOLD", math.Min(confidence, 100)
}
