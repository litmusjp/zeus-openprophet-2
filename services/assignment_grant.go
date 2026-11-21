package services

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"math"
	"strings"
	"time"

	"github.com/alpacahq/alpaca-trade-api-go/v3/marketdata"

	"prophet-trader/interfaces"
)

// Phase C, Step 4 (D10, amendment A1): the server-created authority for an assignment-resolution stock reduction.
//
// A grant is created only by code holding the trading service itself (the resolver), is bound to this service's verified
// paper account, tenant and sandbox, to one group, one symbol, one side and a maximum quantity, and is spent the moment
// its order crosses the broker submission boundary. The grant field on an order is never serialised, so no HTTP request
// or agent tool call can carry one. It does not turn on stock trading for the agent.

func (s *AlpacaTradingService) resolverIdentityReady() bool {
	return s.expectedPaper && strings.TrimSpace(s.expectedAccountID) != "" && strings.TrimSpace(s.expectedTenantID) != "" && strings.TrimSpace(s.expectedSandboxID) != ""
}

// IssueAssignmentResolutionGrant creates a grant for one reduction by one durable resolver order. side is "sell" for
// assigned long stock or "buy" to cover assigned short stock. The registry keeps its own private copy and hands the caller
// a separate copy, so nothing the caller does to the returned object can change what the service trusts.
func (s *AlpacaTradingService) IssueAssignmentResolutionGrant(groupID, clientOrderID, symbol, side string, qty float64) (*interfaces.AssignmentResolutionGrant, error) {
	if !s.resolverIdentityReady() {
		return nil, fmt.Errorf("assignment resolution needs a verified paper account, tenant and sandbox")
	}
	if strings.TrimSpace(groupID) == "" || strings.TrimSpace(clientOrderID) == "" || !validEquitySymbol(symbol) || (side != "buy" && side != "sell") || qty <= 0 || math.IsNaN(qty) || math.IsInf(qty, 0) {
		return nil, fmt.Errorf("assignment resolution grant needs a group, a client order id, an equity symbol, a side and a positive quantity")
	}
	raw := make([]byte, 16)
	if _, err := rand.Read(raw); err != nil {
		return nil, fmt.Errorf("could not create a grant token: %w", err)
	}
	trusted := interfaces.AssignmentResolutionGrant{
		Token: hex.EncodeToString(raw), BrokerAccountID: s.expectedAccountID, TenantID: s.expectedTenantID, SandboxID: s.expectedSandboxID,
		GroupID: groupID, ClientOrderID: clientOrderID, Symbol: symbol, Side: side, Qty: qty,
	}
	s.resolverMu.Lock()
	defer s.resolverMu.Unlock()
	if s.resolverGrants == nil {
		s.resolverGrants = map[string]interfaces.AssignmentResolutionGrant{}
	}
	s.resolverGrants[trusted.Token] = trusted
	handed := trusted
	return &handed, nil
}

// checkResolverGrantLocked requires the order's grant to equal the live grant this service issued, for this identity, and
// the order to match it exactly (symbol, side, quantity within the grant, the one bound client order id, a close). The
// caller holds resolverMu.
func (s *AlpacaTradingService) checkResolverGrantLocked(order *interfaces.Order) error {
	grant := order.ResolverGrant
	if !s.resolverIdentityReady() {
		return fmt.Errorf("assignment resolution needs a verified paper account, tenant and sandbox")
	}
	issued, ok := s.resolverGrants[grant.Token]
	if !ok || grant.Token == "" {
		return fmt.Errorf("assignment resolution grant was not issued by this service or is already spent")
	}
	if issued != *grant {
		return fmt.Errorf("assignment resolution grant does not match the grant that was issued")
	}
	if issued.BrokerAccountID != s.expectedAccountID || issued.TenantID != s.expectedTenantID || issued.SandboxID != s.expectedSandboxID {
		return fmt.Errorf("assignment resolution grant belongs to a different account, tenant or sandbox")
	}
	if order.Purpose != "close" || order.Symbol != issued.Symbol || order.Side != issued.Side || order.Qty > issued.Qty+1e-9 || order.ClientOrderID != issued.ClientOrderID {
		return fmt.Errorf("assignment resolution order does not match its grant")
	}
	return nil
}

// verifyResolverGrant is the early, non-consuming check used during policy evaluation.
func (s *AlpacaTradingService) verifyResolverGrant(order *interfaces.Order) error {
	if order == nil || order.ResolverGrant == nil {
		return nil
	}
	s.resolverMu.Lock()
	defer s.resolverMu.Unlock()
	return s.checkResolverGrantLocked(order)
}

// claimResolverGrant verifies the grant again and spends it in ONE critical section, so two overlapping submissions can
// never both pass: the first claim wins and every other attempt sees a spent grant. It is called immediately before the
// submission marker, so a grant is spent only by an order that is about to cross the broker boundary.
func (s *AlpacaTradingService) claimResolverGrant(order *interfaces.Order) error {
	if order == nil || order.ResolverGrant == nil {
		return nil
	}
	s.resolverMu.Lock()
	defer s.resolverMu.Unlock()
	if err := s.checkResolverGrantLocked(order); err != nil {
		return err
	}
	delete(s.resolverGrants, order.ResolverGrant.Token)
	return nil
}

// RegularSessionOpen reports whether the broker's regular session is open right now. An unreadable clock is an error,
// never "open".
func (s *AlpacaTradingService) RegularSessionOpen(ctx context.Context) (bool, error) {
	if s.clockReader == nil {
		return false, fmt.Errorf("market clock unavailable")
	}
	clock, err := s.clockReader.GetClock()
	if err != nil {
		return false, fmt.Errorf("market clock unavailable: %w", err)
	}
	if clock == nil {
		return false, fmt.Errorf("market clock returned no data")
	}
	return clock.IsOpen, nil
}

// LatestStockQuote returns a stock's bid, ask and quote time. The caller decides whether the quote is fresh enough.
func (s *AlpacaTradingService) LatestStockQuote(ctx context.Context, symbol string) (bid, ask float64, at time.Time, err error) {
	if s.stockQuoteProvider != nil {
		return s.stockQuoteProvider(ctx, symbol)
	}
	if s.dataClient == nil {
		return 0, 0, time.Time{}, fmt.Errorf("stock quote unavailable")
	}
	quote, err := s.dataClient.GetLatestQuote(symbol, marketdata.GetLatestQuoteRequest{})
	if err != nil || quote == nil {
		if err == nil {
			err = fmt.Errorf("empty stock quote")
		}
		return 0, 0, time.Time{}, err
	}
	return quote.BidPrice, quote.AskPrice, quote.Timestamp, nil
}
