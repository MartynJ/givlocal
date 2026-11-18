// Test pages for the BoilerJuice oil panel.
// Shaped like BoilerJuice's tank page as the community boilerjuice-tank-api project reads it.
export const samplePage = (usable : number, total : number, capacity = 1225) => `<html><body>
  <div class="bar-container"><div class="status"><p>Medium</p></div></div>
  <div id="usable-oil-gauge"><div class="gauge" data-percentage="${Math.round(usable / capacity * 100)}"></div>
    <div><p>We estimate that you have ${usable.toLocaleString("en-GB")} litres of usable oil left in your tank.</p></div></div>
  <div id="total-oil-gauge"><div class="gauge" data-percentage="${Math.round(total / capacity * 100)}"></div>
    <div><p>We estimate that you have ${total.toLocaleString("en-GB")} litres of oil left in your tank.</p></div></div>
  <input value="${capacity}" type="number" title="tank-size-count" name="tank[size]">
</body></html>`;

// Shaped like the connected-tank page for a tank with a BoilerJuice monitor (tabs first, then the two gauges).
export const connectedTankPage = (usable : number, total : number, capacity = 2500) => `<html><body>
  <a id="usable-oil-tab">Usable Oil</a><a id="total-oil-tab">Total Oil</a>
  <div id="usable-oil"><div class="gauge" data-percentage="${Math.round(usable / capacity * 100)}"></div>
    <p>We estimate that you have ${usable} litres of usable oil left in your tank.</p>
    <p>${usable}L of usable oil remaining ${total - usable}L of unusable oil (20 %)</p></div>
  <div id="total-oil"><div class="gauge" data-percentage="${Math.round(total / capacity * 100)}"></div>
    <p>We estimate that you have ${total} litres of oil left in your tank. The usable oil in your tank will be less than this.</p></div>
  <input id="tank-size-count" value="${capacity}">
</body></html>`;

// Shaped like the oil orders page.
export const ordersPage = `<h3>Processed Orders</h3><table>
  <tr><th>Order no.</th><th>Order date</th><th>Litres</th><th>Price (ppl)</th><th>Status</th><th>Actions</th></tr>
  <tr><td>6100308</td><td>19 Sep 2026 at 5:33pm</td><td>500</td><td>107.95</td><td>500 litres delivered on 23 Sep 2026</td><td><a>View order</a> <a>Print</a></td></tr>
  <tr><td>5236937</td><td>28 Feb 2026 at 6:34pm</td><td>1,000</td><td>60.85</td><td>1000 litres delivered on 6 Mar 2026</td><td><a>View order</a></td></tr>
</table><h3>Shop Orders</h3><table><tr><td>251067</td><td>29 January 2026</td><td>£20.00</td></tr></table>`;
