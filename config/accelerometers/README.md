# Accelerometer stream profiles

The Node clients read Klipper's streamed accelerometer API. Select a profile with
`--sensor-config`, or copy `custom.example.json` to a local JSON file and edit it.
These JSON files configure the collector only; they do not add or override a
Klipper printer configuration section.

Each profile sets:

- `method`: Klipper API method used to start the sensor stream.
- `params`: method parameters. Update `sensor` to match the configured Klipper object
  name, including a named instance such as `adxl345 toolhead`.
- `data_path`: dot-separated path to the array of streamed samples.
- `header_path`: path to the initial stream header.
- `sample_columns`: array indices for time and XYZ values.

The shipped Klipper profiles use the common `[time, x, y, z]` acceleration sample
layout. For a different API payload shape, adjust the collector adapter as well as
the JSON mapping; changing only a Klipper object name is not sufficient.

The LIS2DW profile is the one used for the original printer validation. Other
profiles are mapped to Klipper's upstream API definitions but have not been
hardware-tested by this project. FLY and other Klipper forks may expose different
API methods; verify their API before using a profile.
