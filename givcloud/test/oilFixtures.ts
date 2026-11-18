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
