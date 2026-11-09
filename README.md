# GivLocal

A replacement for the GivEnergy cloud dashboard, for a GivEnergy All-in-One.

- `givlocal/` is the collector, in Python. It reads the inverter over the home network, keeps the readings in a local database, and uploads them to the hosted app.
- `givcloud/` is the hosted dashboard, built in TypeScript on Anbaric. It covers live and daily energy, health checks and alerts, Octopus meter costs, and savings from solar and battery.

See the README in each folder for setup. `givlocal/upload.conf` holds the upload token and is not committed; copy `givlocal/upload.conf.example` to start one.

## Licence

MIT; see [LICENSE](LICENSE). The bundled `chart.umd.min.js` is Chart.js, also MIT licensed.
