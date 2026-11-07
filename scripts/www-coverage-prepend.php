<?php
// Prepended to every PHP request and command under run-web.sh --www-coverage
// (scripts/web_serve.py): records the lines of FPP's PHP each one ran. Most
// requests run the same lines of the same files, so each file's set of lines
// is written once, named after its contents: a whole suite's run leaves a few
// thousand small files rather than one per request.
final class FppTestsWwwCoverage
{
    public static $keep;

    public static function record()
    {
        $dir = '/artifacts/coverage/www/raw/php';
        foreach (\pcov\collect(\pcov\all) as $file => $lines) {
            $hit = array_keys(array_filter($lines, function ($c) { return $c > 0; }));
            $path = $dir . '/' . md5($file . ':' . implode(',', $hit)) . '.json';
            if (!file_exists($path)) {
                $tmp = $path . '.' . getmypid() . '.tmp';
                if (@file_put_contents($tmp, json_encode(['file' => $file, 'hit' => $hit])) !== false) {
                    @rename($tmp, $path);
                }
            }
        }
    }

    // After every shutdown function, even when one calls exit(), which stops
    // the rest: Limonade's does. A fatal error skips destructors, hence both.
    public function __destruct()
    {
        self::record();
    }
}
\pcov\start();
FppTestsWwwCoverage::$keep = new FppTestsWwwCoverage();
register_shutdown_function(['FppTestsWwwCoverage', 'record']);
