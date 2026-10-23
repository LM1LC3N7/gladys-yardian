# Third-party notices

This integration ports to JavaScript the knowledge of the Yardian local API
held by the following projects: the endpoints of the two API families (YP on
port 880, YC on port 80), the `Yardian-Token` header, the model detection, the
zones per model, the shape of the answers (`result`, `iCode` -1000 for a
refused token, the zone lists, the running tasks), and the bodies of the start
and stop commands. No file is copied, and nothing of them is installed at
runtime; their notices are reproduced below as required by their licenses.

## pyyardian

<https://github.com/h3l1o5/pyyardian> (published on PyPI as `pyyardian`, the
library of the Home Assistant integration), version 1.4.2

```
MIT License

Copyright (c) 2023 Aeon Matrix Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Home Assistant, Yardian integration

<https://github.com/home-assistant/core/tree/dev/homeassistant/components/yardian>,
under the Apache License 2.0 (the license of this repository): the meaning of
`yid` (the unique id), `iRainDelay` (seconds, or an epoch end above a year) and
`iStandby` (the epoch end of the standby). Copyright the Home Assistant
authors.

## LM1LC3N7/gladys-opengarage, gladys-ikea and others

`src/publisher.js` (from gladys-ikea, through gladys-mystrom, gladys-blebox and
gladys-opengarage), `src/yardian/http.js` and the structure of `src/app.js`
(adapted from gladys-opengarage) come from integrations of the same author,
under the Apache License 2.0 of this repository.
