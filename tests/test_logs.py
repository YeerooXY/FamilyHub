import io
import logging
import importlib.util
import pathlib
import unittest

# Load the module by path so the test needs neither Flask nor the rest of the server.
_spec = importlib.util.spec_from_file_location("familyhub_logs", pathlib.Path(__file__).parents[1] / "music_web" / "logs.py")
logs = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(logs)


class LogFormat(unittest.TestCase):
    def render(self, level, colour, name="music_web.movies", message="loaded 4 titles"):
        record = logging.LogRecord(name, level, __file__, 1, message, None, None)
        return logs.LevelFormatter(colour).format(record)

    def test_plain_line_has_level_and_source(self):
        line = self.render(logs.OK, False)
        self.assertRegex(line, r"^\d\d:\d\d:\d\d  OK {8}movies  loaded 4 titles$")

    def test_each_level_has_a_name_and_colour(self):
        for level, name in [(logging.INFO, "INFO"), (logs.OK, "OK"), (logging.WARNING, "WARN"), (logging.ERROR, "ERROR")]:
            self.assertIn(name, self.render(level, False))
            self.assertIn("\x1b[", self.render(level, True))

    def test_warnings_and_errors_colour_the_message(self):
        self.assertIn("\x1b[33mloaded", self.render(logging.WARNING, True))
        self.assertIn("\x1b[31mloaded", self.render(logging.ERROR, True))
        self.assertNotIn("\x1b[32mloaded", self.render(logs.OK, True))

    def test_colour_rules(self):
        class Tty(io.StringIO):
            def isatty(self): return True
        self.assertTrue(logs.wants_colour(Tty(), {}))
        self.assertFalse(logs.wants_colour(io.StringIO(), {}))
        self.assertTrue(logs.wants_colour(io.StringIO(), {"FAMILYHUB_LOG_COLOR": "1"}))
        self.assertFalse(logs.wants_colour(Tty(), {"NO_COLOR": "1", "FAMILYHUB_LOG_COLOR": "1"}))

    def test_configure_is_repeatable_and_ok_method_works(self):
        out = io.StringIO()
        logs.configure("INFO", out, {})
        logs.configure("INFO", out, {})
        logging.getLogger("music_web.test").ok("done")
        self.assertEqual(out.getvalue().count("done"), 1)
        self.assertIn("OK", out.getvalue())


if __name__ == "__main__":
    unittest.main()
